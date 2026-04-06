//! Execution and Validation API handlers

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::sse::{Event, Sse},
    Json,
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::db::repositories::{FlowRepository, ProjectRepository, TestCaseRepository};
use crate::error::AppError;
use crate::execution::{ExecutionEngine, ExecutionEvent, FlowExecutionResult, NodeResult};
use crate::validation::{GraphValidator, ValidationResult};

/// Shared state for execution endpoints (needs flow, test case, and project repos)
#[derive(Clone)]
pub struct ExecutionState {
    pub flow_repo: Arc<dyn FlowRepository>,
    pub tc_repo: Arc<dyn TestCaseRepository>,
    pub project_repo: Arc<dyn ProjectRepository>,
}

/// Optional request body for validation - allows validating unsaved graph changes
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ValidateFlowRequest {
    /// Graph nodes to validate (if not provided, uses saved graph)
    #[serde(default)]
    pub nodes: Option<Vec<serde_json::Value>>,
    /// Graph edges to validate (if not provided, uses saved graph)
    #[serde(default)]
    pub edges: Option<Vec<serde_json::Value>>,
}

/// POST /api/v1/flows/:id/validate - Validate a flow's graph structure
pub async fn validate_flow(
    State(state): State<ExecutionState>,
    Path(flow_id): Path<String>,
    body: Option<Json<ValidateFlowRequest>>,
) -> Result<Json<ValidationResult>, AppError> {
    // Fetch the flow (always needed for flow ID and metadata)
    let mut flow = state.flow_repo.get_by_id(&flow_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", flow_id)))?;

    // If graph data provided in request, use it instead of saved data
    if let Some(Json(req)) = body {
        if req.nodes.is_some() || req.edges.is_some() {
            // Parse the provided graph data
            let nodes: Vec<crate::db::models::GraphNode> = req.nodes
                .map(|n| serde_json::from_value(serde_json::Value::Array(n)))
                .transpose()
                .map_err(|e| AppError::BadRequest(format!("Invalid nodes format: {}", e)))?
                .unwrap_or_else(|| flow.graph_data.nodes.clone());

            let edges: Vec<crate::db::models::GraphEdge> = req.edges
                .map(|e| serde_json::from_value(serde_json::Value::Array(e)))
                .transpose()
                .map_err(|e| AppError::BadRequest(format!("Invalid edges format: {}", e)))?
                .unwrap_or_else(|| flow.graph_data.edges.clone());

            flow.graph_data = crate::db::models::GraphData {
                nodes,
                edges,
                canvas_settings: flow.graph_data.canvas_settings.clone(),
            };
        }
    }

    // Create validator with repository references
    let validator = GraphValidator::new(state.tc_repo.as_ref(), state.flow_repo.as_ref());

    // Validate the flow
    let result = validator.validate(&flow).await?;

    Ok(Json(result))
}

/// Request body for starting an execution
#[derive(Debug, Clone, Deserialize)]
pub struct StartExecutionRequest {
    /// Enable verbose logging in results
    #[serde(default)]
    pub debug_mode: bool,
    /// Environment variables (from project settings)
    #[serde(default)]
    pub environment: HashMap<String, Value>,
    /// Execution variables (overrides environment)
    #[serde(default)]
    pub variables: HashMap<String, Value>,
}

/// Response for execution
#[derive(Debug, Clone, Serialize)]
pub struct ExecutionResponse {
    pub execution_id: String,
    pub flow_id: String,
    pub status: String,
    pub duration_ms: u64,
    pub stats: ExecutionStatsResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecutionStatsResponse {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub errors: usize,
    pub skipped: usize,
}

/// POST /api/v1/flows/:id/execute - Execute a flow synchronously
pub async fn execute_flow(
    State(state): State<ExecutionState>,
    Path(flow_id): Path<String>,
    Json(input): Json<StartExecutionRequest>,
) -> Result<(StatusCode, Json<ExecutionResponse>), AppError> {
    // Fetch the flow
    let flow = state.flow_repo.get_by_id(&flow_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", flow_id)))?;

    // Fetch the project to get base URL from settings
    let project = state.project_repo.get_by_id(&flow.project_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", flow.project_id)))?;

    // Extract base URL from project settings
    let base_url = project.settings.get("baseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Extract project-level variables and merge with request environment
    let mut environment = extract_project_variables(&project.settings);
    for (k, v) in input.environment {
        environment.insert(k, v); // Request values override project variables
    }

    // Generate execution ID
    let execution_id = Uuid::new_v4().to_string();

    // Create execution engine with base URL
    let engine = ExecutionEngine::new(input.debug_mode, base_url);

    // Execute the flow
    let result = engine.execute_flow(
        &execution_id,
        &flow,
        state.tc_repo.as_ref(),
        environment,
        input.variables,
        None, // No WebSocket streaming for sync execution
    ).await?;

    // Convert to response
    let response = convert_to_response(result, input.debug_mode);

    Ok((StatusCode::OK, Json(response)))
}

/// Convert internal result to API response
fn convert_to_response(result: FlowExecutionResult, include_details: bool) -> ExecutionResponse {
    ExecutionResponse {
        execution_id: result.execution_id,
        flow_id: result.flow_id,
        status: result.status,
        duration_ms: result.duration_ms,
        stats: ExecutionStatsResponse {
            total: result.stats.total,
            passed: result.stats.passed,
            failed: result.stats.failed,
            errors: result.stats.errors,
            skipped: result.stats.skipped,
        },
        results: if include_details {
            Some(result.results.iter()
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
                .collect())
        } else {
            None
        },
        context: if include_details {
            Some(result.context)
        } else {
            None
        },
    }
}

/// POST /api/v1/flows/:id/execute-stream - Execute a flow with SSE streaming
///
/// Returns a Server-Sent Events stream with real-time execution progress.
/// Each event is a JSON-encoded ExecutionEvent.
pub async fn execute_flow_stream(
    State(state): State<ExecutionState>,
    Path(flow_id): Path<String>,
    Json(input): Json<StartExecutionRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    // Fetch the flow
    let flow = state.flow_repo.get_by_id(&flow_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", flow_id)))?;

    // Fetch the project to get base URL from settings
    let project = state.project_repo.get_by_id(&flow.project_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", flow.project_id)))?;

    // Extract base URL from project settings
    let base_url = project.settings.get("baseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Extract project-level variables and merge with request environment
    let mut environment = extract_project_variables(&project.settings);
    for (k, v) in input.environment {
        environment.insert(k, v); // Request values override project variables
    }

    // Generate execution ID
    let execution_id = Uuid::new_v4().to_string();

    // Create mpsc channel for streaming events
    let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(100);

    // Clone values for the spawned task
    let tc_repo = state.tc_repo.clone();
    let exec_id = execution_id.clone();
    let debug_mode = input.debug_mode;

    // Spawn execution in background task
    tokio::spawn(async move {
        let engine = ExecutionEngine::new(debug_mode, base_url);
        let _ = engine.execute_flow(
            &exec_id,
            &flow,
            tc_repo.as_ref(),
            environment,
            input.variables,
            Some(tx),
        ).await;
    });

    // Convert mpsc receiver to SSE stream
    let stream = async_stream::stream! {
        while let Some(event) = rx.recv().await {
            let json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
            yield Ok(Event::default().data(json));
        }
    };

    Ok(Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive")
    ))
}

/// Request body for executing a single test case
#[derive(Debug, Clone, Deserialize)]
pub struct ExecuteTestCaseRequest {
    /// Variables to use during execution
    #[serde(default)]
    pub variables: HashMap<String, Value>,
    /// Override: HTTP method (if provided, uses this instead of saved value)
    pub method: Option<String>,
    /// Override: Endpoint URL
    pub endpoint: Option<String>,
    /// Override: Request headers
    pub headers: Option<Value>,
    /// Override: Request payload/body
    pub payload: Option<String>,
    /// Override: Assertion script
    pub assertion_script: Option<String>,
    /// Override: Pre-test script
    pub pre_test_script: Option<String>,
}

/// POST /api/v1/test-cases/:id/execute - Execute a single test case
///
/// If override fields are provided in the request body, they will be used
/// instead of the saved test case values. This allows running unsaved changes.
pub async fn execute_test_case(
    State(state): State<ExecutionState>,
    Path(test_case_id): Path<String>,
    body: Option<Json<ExecuteTestCaseRequest>>,
) -> Result<Json<NodeResult>, AppError> {
    // Fetch the test case
    let mut test_case = state.tc_repo.get_by_id(&test_case_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Test case {} not found", test_case_id)))?;

    // Fetch the project to get base URL from settings
    let project = state.project_repo.get_by_id(&test_case.project_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", test_case.project_id)))?;

    // Extract base URL from project settings
    let base_url = project.settings.get("baseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Extract project-level variables
    let project_variables = extract_project_variables(&project.settings);

    // Apply overrides from request body (for running unsaved changes)
    let variables = if let Some(Json(req)) = body {
        if let Some(method) = req.method {
            test_case.method = method;
        }
        if let Some(endpoint) = req.endpoint {
            test_case.endpoint = endpoint;
        }
        if let Some(headers) = req.headers {
            test_case.headers = headers;
        }
        if let Some(payload) = req.payload {
            test_case.payload = Some(payload);
        }
        if let Some(assertion_script) = req.assertion_script {
            test_case.assertion_script = Some(assertion_script);
        }
        if let Some(pre_test_script) = req.pre_test_script {
            test_case.pre_test_script = Some(pre_test_script);
        }
        req.variables
    } else {
        HashMap::new()
    };

    // Create execution engine
    let engine = ExecutionEngine::new(false, base_url);

    // Execute the test case with project variables as environment
    let result = engine.execute_test_case(&test_case, project_variables, variables).await;

    Ok(Json(result))
}

/// Extract project-level variables from settings JSON
fn extract_project_variables(settings: &Value) -> HashMap<String, Value> {
    settings
        .get("variables")
        .and_then(|v| v.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}
