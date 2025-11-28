//! Execution and Validation API handlers

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

use crate::db::repositories::{FlowRepository, TestCaseRepository};
use crate::error::AppError;
use crate::execution::{ExecutionEngine, FlowExecutionResult};
use crate::validation::{GraphValidator, ValidationResult};

/// Shared state for execution endpoints (needs both repos)
#[derive(Clone)]
pub struct ExecutionState {
    pub flow_repo: Arc<dyn FlowRepository>,
    pub tc_repo: Arc<dyn TestCaseRepository>,
}

/// POST /api/v1/flows/:id/validate - Validate a flow's graph structure
pub async fn validate_flow(
    State(state): State<ExecutionState>,
    Path(flow_id): Path<String>,
) -> Result<Json<ValidationResult>, AppError> {
    // Fetch the flow
    let flow = state.flow_repo.get_by_id(&flow_id).await?
        .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", flow_id)))?;

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

    // Generate execution ID
    let execution_id = Uuid::new_v4().to_string();

    // Create execution engine
    let engine = ExecutionEngine::new(input.debug_mode);

    // Execute the flow
    let result = engine.execute_flow(
        &execution_id,
        &flow,
        state.tc_repo.as_ref(),
        input.environment,
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
