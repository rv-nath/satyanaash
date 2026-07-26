//! Flow execution engine
//!
//! Executes test flows by traversing the graph and running test cases.
//! Uses repository pattern for fetching test case data on-demand.

use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::info;

use crate::db::models::{DataRow, ExportVariable, Flow, GraphNode, TestCase};
use crate::db::repositories::TestCaseRepository;
use crate::error::AppError;

use super::{ExecutionContext, AssertionEngine, HttpExecutor, PreTestScriptEngine};
use super::assertions::AssertionInput;
use super::http::{RequestLog, ResponseLog};

/// The last meaningful line of a script — for an assertion that's the expression
/// whose value decided pass/fail, which is what a failure report should quote.
fn last_expression(script: &str) -> String {
    script
        .lines()
        .map(|l| l.trim().trim_end_matches(';'))
        .filter(|l| !l.is_empty() && !l.starts_with("//"))
        .next_back()
        .unwrap_or("")
        .to_string()
}

/// Collect `{{name}}` placeholders still present in an outgoing request, i.e.
/// variables that failed to resolve.
fn find_unresolved(
    url: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> Vec<String> {
    let re = match regex::Regex::new(r"\{\{([^{}]+)\}\}") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut sources: Vec<&str> = vec![url];
    for v in headers.values() {
        sources.push(v.as_str());
    }
    if let Some(b) = body {
        sources.push(b);
    }
    let mut names: Vec<String> = Vec::new();
    for s in sources {
        for caps in re.captures_iter(s) {
            if let Some(m) = caps.get(1) {
                let name = format!("{{{{{}}}}}", m.as_str().trim());
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    names
}

/// The body this run sends, before interpolation: the row's own body if it gave
/// one, else the test case's payload.
fn resolve_body<'a>(row: Option<&'a DataRow>, test_case: &'a TestCase) -> Option<&'a str> {
    row.and_then(|r| r.body_override())
        .or_else(|| test_case.payload.as_deref())
}

/// The shared post-test script, if there is a non-empty one.
fn shared_script(test_case: &TestCase) -> Option<&str> {
    test_case
        .assertion_script
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The only real differences between the flow-node path and the standalone path.
/// Everything else about running a test case is shared — see `run_once`.
struct RunOptions<'a> {
    /// "direct" for the editor path, the node id for the flow path.
    node_id: &'a str,
    /// Node-level `outputVars`; empty for the standalone path.
    extra_exports: &'a [ExportVariable],
    /// Warn when a `{{name}}` reaches the wire unresolved.
    report_unresolved: bool,
    /// Set on iteration results so the UI can label them.
    row_index: Option<usize>,
    row_label: Option<String>,
}

/// Result status for a node execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
    Passed,
    Failed,
    Error,
    Skipped,
}

impl std::fmt::Display for NodeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeStatus::Passed => write!(f, "passed"),
            NodeStatus::Failed => write!(f, "failed"),
            NodeStatus::Error => write!(f, "error"),
            NodeStatus::Skipped => write!(f, "skipped"),
        }
    }
}

/// Result of executing a single node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeResult {
    pub node_id: String,
    pub test_case_id: Option<String>,
    pub test_case_name: Option<String>,
    pub status: NodeStatus,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestLog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<ResponseLog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exports: Option<HashMap<String, Value>>,
    /// Environment writes made by SAT.env during this run — client persists them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub logs: Vec<String>,
    /// Index of the data row this result came from (iteration results only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_index: Option<usize>,
    /// Label for that row — its name, else "Row N".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_label: Option<String>,
    /// Per-row results. Present only on the aggregate of a "run all rows" run;
    /// every other producer leaves it None so the wire format is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<Vec<NodeResult>>,
}

/// Events emitted during execution (for WebSocket streaming)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEvent {
    /// Execution started
    Started {
        execution_id: String,
        flow_id: String,
        total_nodes: usize,
    },
    /// Node execution started
    NodeStarted {
        node_id: String,
        node_type: String,
        test_case_id: Option<String>,
        test_case_name: Option<String>,
    },
    /// Node execution completed
    NodeCompleted {
        node_id: String,
        result: NodeResult,
    },
    /// Execution completed
    Completed {
        execution_id: String,
        status: String,
        duration_ms: u64,
        passed: usize,
        failed: usize,
        errors: usize,
        skipped: usize,
    },
    /// Execution error
    Error {
        message: String,
    },
}

/// Final execution result
#[derive(Debug, Clone, Serialize)]
pub struct FlowExecutionResult {
    pub execution_id: String,
    pub flow_id: String,
    pub status: String,
    pub duration_ms: u64,
    pub results: Vec<NodeResult>,
    pub context: HashMap<String, Value>,
    pub stats: ExecutionStats,
}

/// Execution statistics
#[derive(Debug, Clone, Serialize, Default)]
pub struct ExecutionStats {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub errors: usize,
    pub skipped: usize,
}

/// Flow execution engine
pub struct ExecutionEngine {
    http: HttpExecutor,
    assertions: AssertionEngine,
    pre_test: PreTestScriptEngine,
    debug_mode: bool,
    base_url: Option<String>,
}

impl ExecutionEngine {
    /// Create a new execution engine
    pub fn new(debug_mode: bool, base_url: Option<String>) -> Self {
        // Normalize base URL: remove trailing slash if present
        let base_url = base_url.map(|u| u.trim_end_matches('/').to_string());

        Self {
            http: HttpExecutor::new(),
            assertions: AssertionEngine::new(),
            pre_test: PreTestScriptEngine::new(),
            debug_mode,
            base_url,
        }
    }

    /// Build the full URL by prepending base_url to relative paths
    fn build_url(&self, endpoint: &str) -> String {
        // If endpoint already has a protocol, use it as-is
        if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
            return endpoint.to_string();
        }

        // Prepend base URL if available
        if let Some(ref base) = self.base_url {
            // Ensure proper joining (base has no trailing /, endpoint starts with /)
            if endpoint.starts_with('/') {
                format!("{}{}", base, endpoint)
            } else {
                format!("{}/{}", base, endpoint)
            }
        } else {
            // No base URL - return as-is (will fail with helpful error in http executor)
            endpoint.to_string()
        }
    }

    /// Execute a flow with optional event streaming
    pub async fn execute_flow(
        &self,
        execution_id: &str,
        flow: &Flow,
        tc_repo: &dyn TestCaseRepository,
        environment: HashMap<String, Value>,
        execution_vars: HashMap<String, Value>,
        event_tx: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<FlowExecutionResult, AppError> {
        let start = std::time::Instant::now();
        let flow_vars = flow.graph_data.variables.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut ctx = ExecutionContext::new(execution_vars, environment, flow_vars);
        let mut results: Vec<NodeResult> = Vec::new();
        let mut stats = ExecutionStats::default();

        // Find START node
        let start_node = flow.graph_data.nodes.iter()
            .find(|n| n.node_type == "start")
            .ok_or_else(|| AppError::BadRequest("Flow has no START node".to_string()))?;

        // Count executable nodes for progress
        let total_nodes = flow.graph_data.nodes.iter()
            .filter(|n| n.node_type == "testCase" || n.node_type == "group")
            .count();

        // Emit started event
        if let Some(tx) = &event_tx {
            let _ = tx.send(ExecutionEvent::Started {
                execution_id: execution_id.to_string(),
                flow_id: flow.id.clone(),
                total_nodes,
            }).await;
        }

        // Cache for test cases to avoid repeated DB lookups
        let mut tc_cache: HashMap<String, TestCase> = HashMap::new();

        // Execute graph starting from START node
        let final_status = self.traverse_and_execute(
            flow,
            &start_node.id,
            tc_repo,
            &mut tc_cache,
            &mut ctx,
            &mut results,
            &mut stats,
            &event_tx,
        ).await?;

        let duration_ms = start.elapsed().as_millis() as u64;

        // Emit completed event
        if let Some(tx) = &event_tx {
            let _ = tx.send(ExecutionEvent::Completed {
                execution_id: execution_id.to_string(),
                status: final_status.clone(),
                duration_ms,
                passed: stats.passed,
                failed: stats.failed,
                errors: stats.errors,
                skipped: stats.skipped,
            }).await;
        }

        Ok(FlowExecutionResult {
            execution_id: execution_id.to_string(),
            flow_id: flow.id.clone(),
            status: final_status,
            duration_ms,
            results,
            context: ctx.get_context().clone(),
            stats,
        })
    }

    /// Traverse graph and execute nodes
    async fn traverse_and_execute(
        &self,
        flow: &Flow,
        current_node_id: &str,
        tc_repo: &dyn TestCaseRepository,
        tc_cache: &mut HashMap<String, TestCase>,
        ctx: &mut ExecutionContext,
        results: &mut Vec<NodeResult>,
        stats: &mut ExecutionStats,
        event_tx: &Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<String, AppError> {
        let node = flow.graph_data.nodes.iter()
            .find(|n| n.id == current_node_id)
            .ok_or_else(|| AppError::Internal(format!("Node '{}' not found", current_node_id)))?;

        match node.node_type.as_str() {
            "start" => {
                // Find outgoing edge and continue
                if let Some(next_id) = self.find_next_node(flow, current_node_id, None) {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, tc_cache, ctx, results, stats, event_tx
                    )).await;
                }
                Ok("completed".to_string())
            }
            "end" => {
                // Reached end node
                Ok("completed".to_string())
            }
            "testCase" => {
                // Execute test case node
                let result = self.execute_test_case_node(
                    node, tc_repo, tc_cache, ctx, event_tx
                ).await;

                let status = result.status.clone();
                stats.total += 1;
                match &status {
                    NodeStatus::Passed => stats.passed += 1,
                    NodeStatus::Failed => stats.failed += 1,
                    NodeStatus::Error => stats.errors += 1,
                    NodeStatus::Skipped => stats.skipped += 1,
                }

                // Emit node completed event
                if let Some(tx) = event_tx {
                    let _ = tx.send(ExecutionEvent::NodeCompleted {
                        node_id: node.id.clone(),
                        result: result.clone(),
                    }).await;
                }

                results.push(result);

                // Determine next node based on status
                let edge_type = match status {
                    NodeStatus::Passed => Some("success"),
                    NodeStatus::Failed => Some("failure"),
                    NodeStatus::Error => return Ok("error".to_string()),
                    NodeStatus::Skipped => None,
                };

                if let Some(next_id) = self.find_next_node(flow, current_node_id, edge_type) {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, tc_cache, ctx, results, stats, event_tx
                    )).await;
                }

                // No next node - determine final status
                match status {
                    NodeStatus::Failed => Ok("failed".to_string()),
                    _ => Ok("completed".to_string()),
                }
            }
            "group" => {
                // TODO: Implement nested flow execution
                // For now, skip group nodes
                if let Some(next_id) = self.find_next_node(flow, current_node_id, Some("success")) {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, tc_cache, ctx, results, stats, event_tx
                    )).await;
                }
                Ok("completed".to_string())
            }
            _ => {
                // Unknown node type, try to continue
                if let Some(next_id) = self.find_next_node(flow, current_node_id, None) {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, tc_cache, ctx, results, stats, event_tx
                    )).await;
                }
                Ok("completed".to_string())
            }
        }
    }

    /// Execute a test case node
    async fn execute_test_case_node(
        &self,
        node: &GraphNode,
        tc_repo: &dyn TestCaseRepository,
        tc_cache: &mut HashMap<String, TestCase>,
        ctx: &mut ExecutionContext,
        event_tx: &Option<mpsc::Sender<ExecutionEvent>>,
    ) -> NodeResult {
        let start = std::time::Instant::now();
        let mut logs = Vec::new();

        // Extract test case ID from node data
        let tc_id = node.data.get("testCaseId")
            .or_else(|| node.data.get("test_case_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let tc_id = match tc_id {
            Some(id) => id,
            None => {
                return NodeResult {
                    node_id: node.id.clone(),
                    test_case_id: None,
                    test_case_name: None,
                    status: NodeStatus::Error,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: None,
                    response: None,
                    exports: None,
                    env: None,
                    error_message: Some("Node missing testCaseId".to_string()),
                    logs,
                    row_index: None,
                    row_label: None,
                    iterations: None,
                };
            }
        };

        // Fetch test case (from cache or DB)
        let test_case = if let Some(tc) = tc_cache.get(&tc_id) {
            tc.clone()
        } else {
            match tc_repo.get_by_id(&tc_id).await {
                Ok(Some(tc)) => {
                    tc_cache.insert(tc_id.clone(), tc.clone());
                    tc
                }
                Ok(None) => {
                    return NodeResult {
                        node_id: node.id.clone(),
                        test_case_id: Some(tc_id),
                        test_case_name: None,
                        status: NodeStatus::Error,
                        duration_ms: start.elapsed().as_millis() as u64,
                        request: None,
                        response: None,
                        exports: None,
                        env: None,
                        error_message: Some("Test case not found".to_string()),
                        logs,
                        row_index: None,
                        row_label: None,
                        iterations: None,
                    };
                }
                Err(e) => {
                    return NodeResult {
                        node_id: node.id.clone(),
                        test_case_id: Some(tc_id),
                        test_case_name: None,
                        status: NodeStatus::Error,
                        duration_ms: start.elapsed().as_millis() as u64,
                        request: None,
                        response: None,
                        exports: None,
                        env: None,
                        error_message: Some(format!("Failed to fetch test case: {}", e)),
                        logs,
                        row_index: None,
                        row_label: None,
                        iterations: None,
                    };
                }
            }
        };

        // Emit node started event (now we have the test case name)
        if let Some(tx) = event_tx {
            let _ = tx.send(ExecutionEvent::NodeStarted {
                node_id: node.id.clone(),
                node_type: "testCase".to_string(),
                test_case_id: Some(tc_id.clone()),
                test_case_name: Some(test_case.name.clone()),
            }).await;
        }

        if self.debug_mode {
            logs.push(format!("Executing test case: {}", test_case.name));
        }

        // Inject node-level input variables (static per-node overrides from flow editor)
        let node_input_vars: HashMap<String, Value> = node.data
            .get("config")
            .and_then(|c| c.get("inputVars"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let key = item.get("key")?.as_str()?;
                        let val = item.get("value")?.as_str()?;
                        if key.is_empty() { return None; }
                        Some((key.to_string(), Value::String(val.to_string())))
                    })
                    .collect()
            })
            .unwrap_or_default();

        if self.debug_mode && !node_input_vars.is_empty() {
            for (k, v) in &node_input_vars {
                logs.push(format!("Node input var: {} = {:?}", k, v));
            }
        }
        ctx.set_node_input_vars(node_input_vars);

        // Accumulates SAT.env writes from pre-test + assertion scripts (persisted by the client)
        let mut env_writes: HashMap<String, Value> = HashMap::new();

        // Node-level outputVars merge with the test case's own exports.
        let node_output_vars: Vec<ExportVariable> = node.data
            .get("config")
            .and_then(|c| c.get("outputVars"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let name = item.get("name")?.as_str()?;
                        let path = item.get("path")?.as_str()?;
                        if name.is_empty() || path.is_empty() { return None; }
                        Some(ExportVariable {
                            name: name.to_string(),
                            json_path: path.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        self.run_once(
            &test_case,
            None,
            ctx,
            RunOptions {
                node_id: &node.id,
                extra_exports: &node_output_vars,
                report_unresolved: false,
                row_index: None,
                row_label: None,
            },
            logs,
            &mut env_writes,
            start,
        )
        .await
    }

    /// Process exports from response using JSONPath
    fn process_exports(
        &self,
        test_case: &TestCase,
        node_exports: &[ExportVariable],
        json: &Option<Value>,
        ctx: &mut ExecutionContext,
        logs: &mut Vec<String>,
    ) -> Option<HashMap<String, Value>> {
        use jsonpath_rust::JsonPath;

        // Combine test case exports and node-level exports (node exports take precedence)
        let all_exports: Vec<&ExportVariable> = {
            let mut combined: Vec<&ExportVariable> = test_case.exports.iter().collect();
            // Node exports override test case exports with the same name
            for ne in node_exports {
                if !combined.iter().any(|e| e.name == ne.name) {
                    combined.push(ne);
                } else {
                    // Replace the test case export with the node export
                    combined.retain(|e| e.name != ne.name);
                    combined.push(ne);
                }
            }
            combined
        };

        if all_exports.is_empty() {
            return None;
        }

        let json = match json {
            Some(j) => j,
            None => return None,
        };

        let mut exported = HashMap::new();

        for export in &all_exports {
            // Use jsonpath_rust trait method to query
            match json.query(&export.json_path) {
                Ok(results) => {
                    if let Some(value) = results.first() {
                        ctx.set(&export.name, (*value).clone());
                        exported.insert(export.name.clone(), (*value).clone());
                        if self.debug_mode {
                            logs.push(format!("Exported {} = {:?}", export.name, value));
                        }
                    }
                }
                Err(e) => {
                    if self.debug_mode {
                        logs.push(format!("Export path error for '{}': {}", export.json_path, e));
                    }
                }
            }
        }

        if exported.is_empty() {
            None
        } else {
            Some(exported)
        }
    }

    /// Find the next node to execute based on edge type
    fn find_next_node(&self, flow: &Flow, current_id: &str, preferred_type: Option<&str>) -> Option<String> {
        let edges: Vec<_> = flow.graph_data.edges.iter()
            .filter(|e| e.source == current_id)
            .collect();

        if edges.is_empty() {
            return None;
        }

        // Edge routing rules:
        // 1. If preferred_type is specified, look for exact match first
        // 2. Then look for "default" type
        // 3. Then use any edge (first one)

        if let Some(ptype) = preferred_type {
            // Look for exact match
            if let Some(edge) = edges.iter().find(|e| {
                e.edge_type.as_ref().map(|t| t == ptype).unwrap_or(false)
            }) {
                return Some(edge.target.clone());
            }
        }

        // Look for default edge
        if let Some(edge) = edges.iter().find(|e| {
            e.edge_type.as_ref().map(|t| t == "default").unwrap_or(false)
        }) {
            return Some(edge.target.clone());
        }

        // Look for edge with no type (implicit default)
        if let Some(edge) = edges.iter().find(|e| e.edge_type.is_none()) {
            return Some(edge.target.clone());
        }

        // Fall back to first edge
        edges.first().map(|e| e.target.clone())
    }

    /// One pre-test → interpolate → HTTP → assert → export cycle.
    ///
    /// Shared by the standalone editor path (`execute_test_case`) and the flow-node
    /// path (`execute_test_case_node`) so the two cannot drift. `ctx` is mutated
    /// (pre-test vars, exports, SAT.env writes); `env_writes` accumulates the
    /// environment writes the client is expected to persist. `start` is passed in so
    /// the reported duration covers the caller's setup (e.g. fetching the test case).
    async fn run_once(
        &self,
        test_case: &TestCase,
        // The data row for this iteration, or None for a normal run.
        row: Option<&DataRow>,
        ctx: &mut ExecutionContext,
        opts: RunOptions<'_>,
        mut logs: Vec<String>,
        env_writes: &mut HashMap<String, Value>,
        start: std::time::Instant,
    ) -> NodeResult {
        // Every early exit reports the same identity; only the message and how far we
        // got differ. Each expansion returns, so moving `logs` repeatedly is fine.
        macro_rules! bail {
            ($msg:expr, $req:expr, $resp:expr) => {
                return NodeResult {
                    node_id: opts.node_id.to_string(),
                    test_case_id: Some(test_case.id.clone()),
                    test_case_name: Some(test_case.name.clone()),
                    status: NodeStatus::Error,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: $req,
                    response: $resp,
                    exports: None,
                    env: None,
                    error_message: Some($msg),
                    logs,
                    row_index: opts.row_index,
                    row_label: opts.row_label.clone(),
                    iterations: None,
                }
            };
        }

        // Execute pre-test script if present (sets variables before interpolation)
        if let Some(ref script) = test_case.pre_test_script {
            if !script.trim().is_empty() {
                match self.pre_test.execute(script, &ctx.environment_snapshot()) {
                    Ok(outcome) => {
                        for (k, v) in outcome.vars {
                            if self.debug_mode {
                                logs.push(format!("Pre-test set: {} = {:?}", k, v));
                            }
                            ctx.set(&k, v);
                        }
                        for (k, v) in outcome.env {
                            ctx.set_environment_var(&k, v.clone());
                            env_writes.insert(k, v);
                        }
                    }
                    Err(e) => bail!(format!("Pre-test script failed: {}", e), None, None),
                }
            }
        }

        // Interpolate endpoint URL and prepend base URL if needed
        let endpoint = match ctx.interpolate(&test_case.endpoint) {
            Ok(u) => u,
            Err(e) => bail!(format!("URL interpolation failed: {}", e), None, None),
        };
        let url = self.build_url(&endpoint);

        if self.debug_mode {
            logs.push(format!("URL: {} {}", test_case.method, url));
        }

        // Convert headers from JSON Value to HashMap
        let mut headers = HashMap::new();
        if let Some(obj) = test_case.headers.as_object() {
            for (key, value) in obj {
                if let Some(v) = value.as_str() {
                    if let (Ok(k), Ok(val)) = (ctx.interpolate(key), ctx.interpolate(v)) {
                        headers.insert(k, val);
                    }
                }
            }
        }

        // Interpolate payload (body)
        // A data row may supply its own body; otherwise the test case's payload is
        // used. Either way it is interpolated, so {{variables}} work in both.
        let body = match resolve_body(row, test_case) {
            Some(payload_str) => match ctx.interpolate(payload_str) {
                Ok(interpolated) => Some(interpolated),
                Err(e) => bail!(format!("Payload interpolation failed: {}", e), None, None),
            },
            None => None,
        };

        // Variables that never resolved go out as literal "{{name}}" text — usually
        // the real cause of a puzzling 4xx. Say so instead of failing silently.
        if opts.report_unresolved {
            let unresolved = find_unresolved(&url, &headers, body.as_deref());
            if !unresolved.is_empty() {
                logs.push(format!(
                    "⚠ Unresolved variable(s) sent literally: {}",
                    unresolved.join(", ")
                ));
            }
        }

        // Capture request info before executing (for debugging even on failure)
        let request_log = RequestLog {
            method: test_case.method.clone(),
            url: url.clone(),
            headers: headers.clone(),
            body: body.clone(),
        };

        // Execute HTTP request
        let http_result = match self
            .http
            .execute(&test_case.method, &url, &headers, body.as_deref())
            .await
        {
            Ok(r) => r,
            Err(e) => bail!(
                format!("HTTP request failed: {}", e),
                Some(request_log),
                None
            ),
        };

        if self.debug_mode {
            logs.push(format!("Response status: {}", http_result.response.status));
        }

        // One line per request at info level. Without this the server is silent
        // during a run: tower-http's TraceLayer only logs at debug, and no handler
        // logs anything.
        let row_note = opts
            .row_label
            .as_deref()
            .map(|l| format!(" [{}]", l))
            .unwrap_or_default();
        info!(
            "{} {} -> {} ({}ms){}",
            test_case.method,
            url,
            http_result.response.status,
            start.elapsed().as_millis(),
            row_note
        );

        // Run assertions. On failure we record *why*, so the console shows a reason
        // instead of a bare "failed".
        let mut assertion_failure: Option<String> = None;
        let status_code = http_result.response.status;

        // The post-test script always runs when present — it may exist purely to
        // capture values into SAT.vars / SAT.env. Its verdict is only *used* when
        // the row didn't state an expected status.
        let mut script_verdict: Option<bool> = None;
        let script = shared_script(test_case);
        if let Some(script) = script {
            match self.assertions.evaluate(AssertionInput {
                script,
                status: status_code,
                body: &http_result.response.body,
                json: &http_result.response.json,
                headers: &http_result.response.headers,
                env: &ctx.environment_snapshot(),
            }) {
                Ok(outcome) => {
                    script_verdict = outcome.passed;
                    for (k, v) in outcome.vars {
                        ctx.set(&k, v);
                    }
                    for (k, v) in outcome.env {
                        ctx.set_environment_var(&k, v.clone());
                        env_writes.insert(k, v);
                    }
                }
                // The script couldn't run at all — a defect in the test, not a
                // failed check. Say so, and don't persist whatever it managed to
                // write before throwing: half-captured values poison later runs.
                Err(e) => bail!(
                    format!("Post-test script could not run: {}", e),
                    Some(http_result.request),
                    Some(http_result.response)
                ),
            }
        }

        let expected = row.and_then(|r| r.expected_status_code());
        let assertion_passed = match (expected, script_verdict) {
            // A row's expected status is the verdict — the script above still ran.
            (Some(code), _) => {
                let passed = status_code == code;
                if !passed {
                    let reason = format!("Expected HTTP {}, got {}", code, status_code);
                    logs.push(reason.clone());
                    assertion_failure = Some(reason);
                }
                passed
            }
            // Otherwise the script decides.
            (None, Some(verdict)) => {
                if !verdict {
                    let reason = format!(
                        "Assertion returned false: {}  (actual: HTTP {})",
                        last_expression(script.unwrap_or("")), status_code
                    );
                    logs.push(reason.clone());
                    assertion_failure = Some(reason);
                }
                verdict
            }
            // A script that returned no boolean and no expected status to fall back
            // on: say so plainly rather than reporting a Rhai type error.
            (None, None) if script.is_some() => bail!(
                "This test has no expected status, so its script must end in a \
                 true/false expression (e.g. `response.status == 201`)."
                    .to_string(),
                Some(http_result.request),
                Some(http_result.response)
            ),
            // Nothing specified anywhere: any 2xx passes.
            (None, None) => {
                let passed = AssertionEngine::default_assertion(status_code);
                if !passed {
                    let reason =
                        format!("Assertion failed: expected a 2xx status, got HTTP {}", status_code);
                    logs.push(reason.clone());
                    assertion_failure = Some(reason);
                }
                passed
            }
        };

        // Process exports only if the assertion passed
        let exports = if assertion_passed {
            self.process_exports(
                test_case,
                opts.extra_exports,
                &http_result.response.json,
                ctx,
                &mut logs,
            )
        } else {
            None
        };

        NodeResult {
            node_id: opts.node_id.to_string(),
            test_case_id: Some(test_case.id.clone()),
            test_case_name: Some(test_case.name.clone()),
            status: if assertion_passed { NodeStatus::Passed } else { NodeStatus::Failed },
            duration_ms: start.elapsed().as_millis() as u64,
            request: Some(http_result.request),
            response: Some(http_result.response),
            exports,
            env: if env_writes.is_empty() { None } else { Some(env_writes.clone()) },
            error_message: assertion_failure,
            logs,
            row_index: opts.row_index,
            row_label: opts.row_label,
            iterations: None,
        }
    }

    /// Run a test case once per data row and return one aggregate result whose
    /// `iterations` holds the per-row results.
    ///
    /// Each row gets a *clone* of the base context so exports and pre-test vars
    /// can't leak between rows — but `SAT.env` writes are folded forward, so a
    /// later row does see what an earlier one persisted. Rows run sequentially and
    /// a failing row never stops the rest.
    pub async fn execute_test_case_dataset(
        &self,
        test_case: &TestCase,
        environment: HashMap<String, Value>,
        variables: HashMap<String, Value>,
    ) -> NodeResult {
        let start = std::time::Instant::now();
        let rows: Vec<DataRow> = test_case
            .dataset
            .as_ref()
            .map(|d| d.rows.clone())
            .unwrap_or_default();

        let mut base_ctx = ExecutionContext::new(variables, environment, HashMap::new());
        let mut aggregate_env: HashMap<String, Value> = HashMap::new();
        let mut iterations: Vec<NodeResult> = Vec::with_capacity(rows.len());

        info!("Running \"{}\" over {} data row(s)", test_case.name, rows.len());

        for (index, row) in rows.iter().enumerate() {
            let label = crate::db::models::Dataset::label_for(index, row);
            let mut row_ctx = base_ctx.clone();
            let mut row_env: HashMap<String, Value> = HashMap::new();

            let result = self
                .run_once(
                    test_case,
                    Some(row),
                    &mut row_ctx,
                    RunOptions {
                        node_id: "direct",
                        extra_exports: &[],
                        report_unresolved: true,
                        row_index: Some(index),
                        row_label: Some(label.clone()),
                    },
                    Vec::new(),
                    &mut row_env,
                    std::time::Instant::now(),
                )
                .await;

            // Carry SAT.env writes forward to later rows and into the aggregate.
            for (k, v) in row_env {
                base_ctx.set_environment_var(&k, v.clone());
                aggregate_env.insert(k, v);
            }
            iterations.push(result);
        }

        let failed = iterations.iter().filter(|r| r.status == NodeStatus::Failed).count();
        let errored = iterations.iter().filter(|r| r.status == NodeStatus::Error).count();
        let status = if errored > 0 {
            NodeStatus::Error
        } else if failed > 0 {
            NodeStatus::Failed
        } else {
            NodeStatus::Passed
        };
        let not_passed = failed + errored;
        let error_message = (not_passed > 0)
            .then(|| format!("{} of {} rows did not pass", not_passed, iterations.len()));
        info!(
            "\"{}\" finished: {} of {} rows passed ({}ms)",
            test_case.name,
            iterations.len() - not_passed,
            iterations.len(),
            start.elapsed().as_millis()
        );

        // Prefix each row's logs so a flat log view still says which row spoke.
        let logs = iterations
            .iter()
            .flat_map(|r| {
                let label = r.row_label.clone().unwrap_or_default();
                r.logs.iter().map(move |l| format!("[{}] {}", label, l))
            })
            .collect();

        NodeResult {
            node_id: "direct".to_string(),
            test_case_id: Some(test_case.id.clone()),
            test_case_name: Some(test_case.name.clone()),
            status,
            duration_ms: start.elapsed().as_millis() as u64,
            // Deliberately None: an aggregate has no single request/response, and
            // the UI branches on `iterations` to render the per-row matrix.
            request: None,
            response: None,
            exports: None,
            env: if aggregate_env.is_empty() { None } else { Some(aggregate_env) },
            error_message,
            logs,
            row_index: None,
            row_label: None,
            iterations: Some(iterations),
        }
    }

    /// Execute a single test case directly (without flow context)
    /// Used for testing individual test cases from the editor
    pub async fn execute_test_case(
        &self,
        test_case: &TestCase,
        environment: HashMap<String, Value>,
        variables: HashMap<String, Value>,
    ) -> NodeResult {
        let start = std::time::Instant::now();
        let mut logs = Vec::new();
        let mut ctx = ExecutionContext::new(variables, environment, HashMap::new());

        // Accumulates SAT.env writes from pre-test + assertion scripts (persisted by the client)
        let mut env_writes: HashMap<String, Value> = HashMap::new();

        if self.debug_mode {
            logs.push(format!("Executing test case: {}", test_case.name));
        }

        self.run_once(
            test_case,
            None,
            &mut ctx,
            RunOptions {
                node_id: "direct",
                extra_exports: &[],
                report_unresolved: true,
                row_index: None,
                row_label: None,
            },
            logs,
            &mut env_writes,
            start,
        )
        .await
    }
}

impl Default for ExecutionEngine {
    fn default() -> Self {
        Self::new(false, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dataset_of(rows: Vec<(&str, Option<&str>, Option<&str>)>) -> crate::db::models::Dataset {
        crate::db::models::Dataset {
            rows: rows
                .into_iter()
                .enumerate()
                .map(|(i, (name, body, status))| DataRow {
                    id: format!("r{}", i),
                    name: Some(name.to_string()),
                    body: body.map(str::to_string),
                    expected_status: status.map(str::to_string),
                })
                .collect(),
        }
    }

    #[test]
    fn test_resolve_body_prefers_the_row() {
        let mut tc = make_test_case("t1", "T", "/x", "POST");
        tc.payload = Some(r#"{"shared":true}"#.to_string());

        // No row, or a row that gave no body: the test case's payload is used.
        assert_eq!(resolve_body(None, &tc), Some(r#"{"shared":true}"#));
        let bare = DataRow::default();
        assert_eq!(resolve_body(Some(&bare), &tc), Some(r#"{"shared":true}"#));
        let blank = DataRow { body: Some("   ".into()), ..Default::default() };
        assert_eq!(resolve_body(Some(&blank), &tc), Some(r#"{"shared":true}"#));

        // A row with a body replaces it.
        let own = DataRow { body: Some("{}".into()), ..Default::default() };
        assert_eq!(resolve_body(Some(&own), &tc), Some("{}"));
    }

    #[test]
    fn test_shared_script_ignores_blanks() {
        let mut tc = make_test_case("t1", "T", "/x", "POST");
        assert_eq!(shared_script(&tc), None);

        tc.assertion_script = Some("   ".to_string());
        assert_eq!(shared_script(&tc), None, "whitespace-only is not a script");

        tc.assertion_script = Some(" response.status == 200 ".to_string());
        assert_eq!(shared_script(&tc), Some("response.status == 200"));
    }

    #[tokio::test]
    async fn test_dataset_runs_once_per_row_with_its_own_body() {
        // Port 1 refuses instantly, but RequestLog is still captured — the same
        // trick test_execute_flow_with_variables uses to assert what was sent
        // without standing up a server.
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc1", "SignUp", "http://127.0.0.1:1/u", "POST");
        tc.payload = Some(r#"{"email":"{{email}}"}"#.to_string());
        tc.dataset = Some(dataset_of(vec![
            ("shared body", None, Some("201")),
            ("empty body", Some("{}"), Some("400")),
            ("interpolated", Some(r#"{"who":"{{email}}"}"#), Some("400")),
        ]));

        let mut env = HashMap::new();
        env.insert("email".to_string(), Value::String("a@b.com".into()));
        let result = engine.execute_test_case_dataset(&tc, env, HashMap::new()).await;
        let its = result.iterations.as_ref().expect("aggregate carries iterations");

        assert_eq!(its.len(), 3);
        // Row 1 fell back to the test case's payload.
        assert_eq!(its[0].request.as_ref().unwrap().body.as_deref(), Some(r#"{"email":"a@b.com"}"#));
        // Row 2 replaced it outright.
        assert_eq!(its[1].request.as_ref().unwrap().body.as_deref(), Some("{}"));
        // Row 3's own body is still interpolated.
        assert_eq!(its[2].request.as_ref().unwrap().body.as_deref(), Some(r#"{"who":"a@b.com"}"#));

        assert_eq!(its[0].row_index, Some(0));
        assert_eq!(its[1].row_label.as_deref(), Some("empty body"));
        // The aggregate has no single request/response; the UI uses `iterations`.
        assert!(result.request.is_none() && result.response.is_none());
    }

    #[tokio::test]
    async fn test_flow_ignores_the_dataset() {
        // A flow runs the test case as authored — once, with no row applied — so
        // adding a dataset never changes flow behaviour.
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc1", "SignUp", "http://127.0.0.1:1/u", "POST");
        tc.payload = Some(r#"{"shared":true}"#.to_string());
        tc.dataset = Some(dataset_of(vec![("a", Some("{}"), Some("400"))]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("n1", "testCase", serde_json::json!({"testCaseId": "tc1"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "n1", None),
            make_edge("e2", "n1", "end", Some("success")),
        ]);

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        assert_eq!(result.results.len(), 1, "one node result, not one per row");
        assert!(result.results[0].iterations.is_none());
        // The shared payload was sent, not the row's.
        assert_eq!(result.results[0].request.as_ref().unwrap().body.as_deref(),
                   Some(r#"{"shared":true}"#));
    }

    #[test]
    fn test_last_expression_picks_the_deciding_line() {
        let script = "// save it\nSAT.vars.token = response.json.token;\n\nresponse.status == 230;\n";
        assert_eq!(last_expression(script), "response.status == 230");
        assert_eq!(last_expression(""), "");
    }

    #[test]
    fn test_find_unresolved_reports_literal_placeholders() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer {{token}}".to_string());
        let found = find_unresolved(
            "http://x/api/{{id}}",
            &headers,
            Some(r#"{"phone":"{{my_phone_number}}","ok":"resolved"}"#),
        );
        assert!(found.contains(&"{{id}}".to_string()));
        assert!(found.contains(&"{{token}}".to_string()));
        assert!(found.contains(&"{{my_phone_number}}".to_string()));
        assert_eq!(found.len(), 3);

        // Nothing left over once everything resolved
        assert!(find_unresolved("http://x/api/1", &HashMap::new(), Some("{}")).is_empty());
    }
    use crate::db::models::{Flow, GraphData, GraphNode, GraphEdge, Position, TestCase, ExportVariable};
    use crate::db::repositories::TestCaseRepository;
    use crate::error::AppError;
    use async_trait::async_trait;
    use std::collections::HashSet;
    use chrono::Utc;

    // =========================================================================
    // Mock Repository
    // =========================================================================

    /// Mock test case repository for testing
    struct MockTestCaseRepository {
        test_cases: HashMap<String, TestCase>,
    }

    impl MockTestCaseRepository {
        fn new() -> Self {
            Self { test_cases: HashMap::new() }
        }

        fn with_test_case(mut self, tc: TestCase) -> Self {
            self.test_cases.insert(tc.id.clone(), tc);
            self
        }
    }

    #[async_trait]
    impl TestCaseRepository for MockTestCaseRepository {
        async fn create(&self, _project_id: &str, _input: crate::db::models::CreateTestCase) -> Result<TestCase, AppError> {
            unimplemented!()
        }
        async fn get_by_id(&self, id: &str) -> Result<Option<TestCase>, AppError> {
            Ok(self.test_cases.get(id).cloned())
        }
        async fn list_by_project(&self, _project_id: &str, _pagination: crate::db::models::Pagination) -> Result<crate::db::models::PaginatedResponse<TestCase>, AppError> {
            Ok(crate::db::models::PaginatedResponse {
                data: self.test_cases.values().cloned().collect(),
                pagination: crate::db::models::PaginationMeta {
                    page: 1,
                    per_page: 100,
                    total: self.test_cases.len() as u64,
                    total_pages: 1,
                },
            })
        }
        async fn update(&self, _id: &str, _input: crate::db::models::UpdateTestCase) -> Result<TestCase, AppError> {
            unimplemented!()
        }
        async fn delete(&self, _id: &str) -> Result<(), AppError> {
            unimplemented!()
        }
        async fn find_existing_ids(&self, ids: &[String]) -> Result<HashSet<String>, AppError> {
            Ok(ids.iter().filter(|id| self.test_cases.contains_key(*id)).cloned().collect())
        }
    }

    // =========================================================================
    // Helper Functions
    // =========================================================================

    fn make_test_case(id: &str, name: &str, endpoint: &str, method: &str) -> TestCase {
        TestCase {
            id: id.to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: name.to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: method.to_string(),
            endpoint: endpoint.to_string(),
            headers: serde_json::json!({}),
            payload: None,
            exports: vec![],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn make_flow(id: &str, nodes: Vec<GraphNode>, edges: Vec<GraphEdge>) -> Flow {
        Flow {
            id: id.to_string(),
            project_id: "proj1".to_string(),
            name: "Test Flow".to_string(),
            description: None,
            graph_data: GraphData { nodes, edges, canvas_settings: serde_json::json!({}), variables: HashMap::new() },
            version: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn make_node(id: &str, node_type: &str, data: serde_json::Value) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            position: Position { x: 0.0, y: 0.0 },
            data,
            width: None,
            height: None,
        }
    }

    fn make_edge(id: &str, source: &str, target: &str, edge_type: Option<&str>) -> GraphEdge {
        GraphEdge {
            id: id.to_string(),
            source: source.to_string(),
            target: target.to_string(),
            edge_type: edge_type.map(|s| s.to_string()),
            data: serde_json::json!({}),
        }
    }

    // =========================================================================
    // Basic Tests
    // =========================================================================

    #[test]
    fn test_node_status_display() {
        assert_eq!(NodeStatus::Passed.to_string(), "passed");
        assert_eq!(NodeStatus::Failed.to_string(), "failed");
        assert_eq!(NodeStatus::Error.to_string(), "error");
        assert_eq!(NodeStatus::Skipped.to_string(), "skipped");
    }

    #[test]
    fn test_execution_stats_default() {
        let stats = ExecutionStats::default();
        assert_eq!(stats.total, 0);
        assert_eq!(stats.passed, 0);
        assert_eq!(stats.failed, 0);
        assert_eq!(stats.errors, 0);
        assert_eq!(stats.skipped, 0);
    }

    #[test]
    fn test_engine_creation() {
        let engine = ExecutionEngine::new(false, None);
        assert!(!engine.debug_mode);

        let engine_debug = ExecutionEngine::new(true, None);
        assert!(engine_debug.debug_mode);
    }

    // =========================================================================
    // Edge Routing Tests
    // =========================================================================

    #[test]
    fn test_find_next_node_success_edge() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({"testCaseId": "tc1"})),
            make_node("end_success", "end", serde_json::json!({})),
            make_node("end_failure", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end_success", Some("success")),
            make_edge("e3", "tc1", "end_failure", Some("failure")),
        ]);

        // Should find success edge
        let next = engine.find_next_node(&flow, "tc1", Some("success"));
        assert_eq!(next, Some("end_success".to_string()));

        // Should find failure edge
        let next = engine.find_next_node(&flow, "tc1", Some("failure"));
        assert_eq!(next, Some("end_failure".to_string()));
    }

    #[test]
    fn test_find_next_node_default_edge() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", Some("default")),
            make_edge("e2", "tc1", "end", Some("default")),
        ]);

        // Should find default edge when no preferred type matches
        let next = engine.find_next_node(&flow, "tc1", Some("success"));
        assert_eq!(next, Some("end".to_string()));
    }

    #[test]
    fn test_find_next_node_no_type_edge() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", None), // No type = implicit default
        ]);

        // Should find edge with no type
        let next = engine.find_next_node(&flow, "tc1", Some("success"));
        assert_eq!(next, Some("end".to_string()));
    }

    #[test]
    fn test_find_next_node_no_edges() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("end", "end", serde_json::json!({})),
        ], vec![]);

        let next = engine.find_next_node(&flow, "end", None);
        assert_eq!(next, None);
    }

    // =========================================================================
    // Flow Execution Tests (Integration with Mock)
    // =========================================================================

    #[tokio::test]
    async fn test_execute_empty_flow_no_start() {
        let engine = ExecutionEngine::new(false, None);
        let repo = MockTestCaseRepository::new();

        // Flow with no START node
        let flow = make_flow("flow1", vec![
            make_node("end", "end", serde_json::json!({})),
        ], vec![]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await;

        assert!(result.is_err());
        match result {
            Err(AppError::BadRequest(msg)) => assert!(msg.contains("START")),
            _ => panic!("Expected BadRequest error"),
        }
    }

    #[tokio::test]
    async fn test_execute_flow_start_to_end() {
        let engine = ExecutionEngine::new(false, None);
        let repo = MockTestCaseRepository::new();

        // Simple flow: START -> END (no test cases)
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "end", None),
        ]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await.unwrap();

        assert_eq!(result.status, "completed");
        assert_eq!(result.stats.total, 0);
        assert_eq!(result.stats.passed, 0);
    }

    #[tokio::test]
    async fn test_execute_flow_missing_test_case() {
        let engine = ExecutionEngine::new(true, None);
        let repo = MockTestCaseRepository::new(); // Empty repo

        // Flow references a test case that doesn't exist
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({"testCaseId": "nonexistent"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", Some("success")),
        ]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await.unwrap();

        // Should have 1 error (test case not found)
        assert_eq!(result.stats.total, 1);
        assert_eq!(result.stats.errors, 1);
        assert_eq!(result.results[0].status, NodeStatus::Error);
        assert!(result.results[0].error_message.as_ref().unwrap().contains("not found"));
        // Guards the run_once extraction: node_id must stay the graph node's id,
        // not the standalone path's "direct". Nothing else would catch a slip here.
        assert_eq!(result.results[0].node_id, "tc1");
    }

    #[tokio::test]
    async fn test_standalone_run_is_labelled_direct() {
        // Companion guard to the flow-side node_id assertion above.
        let engine = ExecutionEngine::new(false, None);
        let tc = make_test_case("tc-x", "Standalone", "http://127.0.0.1:1/unreachable", "GET");

        let result = engine
            .execute_test_case(&tc, HashMap::new(), HashMap::new())
            .await;

        assert_eq!(result.node_id, "direct");
        assert_eq!(result.test_case_id.as_deref(), Some("tc-x"));
        // Connection refused, but the request log is still captured.
        assert_eq!(result.status, NodeStatus::Error);
        assert!(result.request.is_some());
    }

    #[tokio::test]
    async fn test_execute_flow_node_missing_test_case_id() {
        let engine = ExecutionEngine::new(true, None);
        let repo = MockTestCaseRepository::new();

        // testCase node without testCaseId in data
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({})), // Missing testCaseId
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", Some("success")),
        ]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await.unwrap();

        assert_eq!(result.stats.errors, 1);
        assert!(result.results[0].error_message.as_ref().unwrap().contains("testCaseId"));
    }

    // =========================================================================
    // Variable Interpolation in Execution
    // =========================================================================

    #[tokio::test]
    async fn test_execute_flow_with_variables() {
        let engine = ExecutionEngine::new(true, None);

        // Create test case with variable in endpoint
        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test with Vars".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "{{baseUrl}}/users/{{userId}}".to_string(),
            headers: serde_json::json!({"Authorization": "Bearer {{token}}"}),
            payload: None,
            exports: vec![],
            assertion_script: Some("response.status == 200".to_string()),
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({"testCaseId": "tc1"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", Some("success")),
        ]);

        // Pass variables
        let mut vars = HashMap::new();
        vars.insert("baseUrl".to_string(), Value::String("https://api.example.com".to_string()));
        vars.insert("userId".to_string(), Value::String("123".to_string()));
        vars.insert("token".to_string(), Value::String("secret-token".to_string()));

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(), // environment
            vars,           // execution vars
            None,
        ).await.unwrap();

        // Check that URL was interpolated
        let request = result.results[0].request.as_ref().unwrap();
        assert_eq!(request.url, "https://api.example.com/users/123");
        assert_eq!(request.headers.get("Authorization"), Some(&"Bearer secret-token".to_string()));
    }

    // =========================================================================
    // Export Tests
    // =========================================================================

    #[test]
    fn test_process_exports_simple() {
        let engine = ExecutionEngine::new(true, None);

        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "http://test.com".to_string(),
            headers: serde_json::json!({}),
            payload: None,
            exports: vec![
                ExportVariable { name: "token".to_string(), json_path: "$.data.token".to_string() },
                ExportVariable { name: "userId".to_string(), json_path: "$.data.user.id".to_string() },
            ],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let json = Some(serde_json::json!({
            "data": {
                "token": "abc123",
                "user": { "id": 42 }
            }
        }));

        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();

        let exports = engine.process_exports(&tc, &[], &json, &mut ctx, &mut logs);

        assert!(exports.is_some());
        let exports = exports.unwrap();
        assert_eq!(exports.get("token"), Some(&Value::String("abc123".to_string())));
        assert_eq!(exports.get("userId"), Some(&Value::Number(42.into())));

        // Check context was updated
        assert_eq!(ctx.resolve("token"), Some(&Value::String("abc123".to_string())));
    }

    #[test]
    fn test_process_exports_no_json() {
        let engine = ExecutionEngine::new(true, None);

        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "http://test.com".to_string(),
            headers: serde_json::json!({}),
            payload: None,
            exports: vec![
                ExportVariable { name: "token".to_string(), json_path: "$.token".to_string() },
            ],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();

        let exports = engine.process_exports(&tc, &[], &None, &mut ctx, &mut logs);
        assert!(exports.is_none());
    }

    #[test]
    fn test_process_exports_empty_exports() {
        let engine = ExecutionEngine::new(true, None);

        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "http://test.com".to_string(),
            headers: serde_json::json!({}),
            payload: None,
            exports: vec![], // No exports
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let json = Some(serde_json::json!({"data": "test"}));
        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();

        let exports = engine.process_exports(&tc, &[], &json, &mut ctx, &mut logs);
        assert!(exports.is_none());
    }
}
