//! Flow execution engine
//!
//! Executes test flows by traversing the graph and running test cases.
//! Uses repository pattern for fetching test case data on-demand.

use std::borrow::Cow;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::info;

use crate::db::models::{DataRow, ExportVariable, Flow, GraphNode, TestCase};
use crate::db::repositories::TestCaseRepository;
use crate::error::AppError;

use super::{ExecutionContext, AssertionEngine, HttpExecutor, PreTestScriptEngine, VarSource};
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

/// The endpoint template for this row: the test case's, plus whatever the row appends.
///
/// Composed *before* interpolation, so the result is what gets interpolated, scanned
/// for unresolved names, checked for leftover "null"s and reported by the provenance
/// log. Reading `test_case.endpoint` directly anywhere in the request cycle would make
/// a row's own `{{org}}` invisible to all four.
fn resolve_endpoint<'a>(row: Option<&'a DataRow>, test_case: &'a TestCase) -> Cow<'a, str> {
    let Some(suffix) = row.and_then(|r| r.path_suffix()) else {
        return Cow::Borrowed(&test_case.endpoint);
    };
    // A row adding "?org=acme" to an endpoint that already has a query would otherwise
    // produce "?limit=10?org=acme" — a URL the server reads as one broken parameter.
    let joined = if suffix.starts_with('?') && test_case.endpoint.contains('?') {
        format!("{}&{}", test_case.endpoint, &suffix[1..])
    } else {
        format!("{}{}", test_case.endpoint, suffix)
    };
    Cow::Owned(joined)
}

/// The shared post-test script, if there is a non-empty one.
/// An AppError's own prefix reads as noise once the caller has said which script
/// failed: "This row's check could not run: Assertion error: …" says it twice.
fn plain(e: &AppError) -> String {
    let msg = e.to_string();
    for prefix in ["Assertion error: ", "Internal error: "] {
        if let Some(rest) = msg.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    msg
}

/// "(body has: access_token, refresh_token)" — enough to spot a misspelling
/// without dumping a whole response into the log.
fn top_level_keys(json: &Value) -> String {
    const MAX: usize = 8;
    match json.as_object() {
        Some(map) if !map.is_empty() => {
            let mut names: Vec<&str> = map.keys().take(MAX).map(String::as_str).collect();
            let more = map.len().saturating_sub(names.len());
            let tail = if more > 0 { format!(", … {} more", more) } else { String::new() };
            names.sort_unstable();
            format!(" (body has: {}{})", names.join(", "), tail)
        }
        _ => String::new(),
    }
}

/// What a hand-written check says: a bare status code, a Rhai expression, or
/// nothing. Written once because a dataset row's Expect and a node's Expect mean
/// exactly the same thing and must not drift apart.
enum Check<'a> {
    Status(u16),
    Expr(&'a str),
    Unstated,
}

fn parse_check(raw: Option<&str>) -> Check<'_> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Check::Unstated,
        Some(text) => match text.parse::<u16>() {
            Ok(status) => Check::Status(status),
            Err(_) => Check::Expr(text),
        },
    }
}

/// A node marked "always run": teardown. Excluded from the normal path and run
/// after it, however the run ended.
fn is_teardown(node: &GraphNode) -> bool {
    node.data
        .get("config")
        .and_then(|c| c.get("teardown"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// A node's fan-out choice, as the canvas stores it.
#[derive(Debug, PartialEq)]
enum FanOut {
    /// Run the request once, as authored — the dataset is ignored.
    Off,
    /// One request per row, every row.
    AllRows,
    /// One request per row, for these row ids.
    Rows(Vec<String>),
}

/// `config.forEachRow` marks a node; `config.rowIds` narrows it.
///
/// **An absent `rowIds` means every row** — absence is already how this config says
/// "unset", and it means a row added to the dataset later is included without anyone
/// revisiting the node. An *empty* list is different: it means none, and the node says
/// so rather than helpfully running everything the author just unticked.
fn fan_out(node: &GraphNode) -> FanOut {
    let config = node.data.get("config");
    let marked = config
        .and_then(|c| c.get("forEachRow"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !marked {
        return FanOut::Off;
    }
    match config.and_then(|c| c.get("rowIds")).and_then(|v| v.as_array()) {
        None => FanOut::AllRows,
        Some(ids) => {
            let mut wanted: Vec<String> = Vec::new();
            for id in ids.iter().filter_map(|v| v.as_str()) {
                let id = id.trim();
                if !id.is_empty() && !wanted.iter().any(|seen| seen == id) {
                    wanted.push(id.to_string());
                }
            }
            FanOut::Rows(wanted)
        }
    }
}

/// What a node will actually run.
enum RowPlan {
    /// Once, as authored.
    Once,
    /// One request per row, in dataset order whatever order they were selected in.
    Rows(Vec<(usize, DataRow)>),
    /// Rows were chosen and none of them are there any more.
    NothingSelected(String),
}

/// Work out which rows a node runs, saying out loud anything that narrows the plan.
///
/// A selection is never quietly shortened: the author asked for coverage, and coverage
/// silently going missing is how a green run comes to mean nothing.
fn plan_rows(node: &GraphNode, test_case: &TestCase, logs: &mut Vec<String>) -> RowPlan {
    let choice = fan_out(node);
    if choice == FanOut::Off {
        return RowPlan::Once;
    }

    let rows: Vec<DataRow> = test_case
        .dataset
        .as_ref()
        .map(|d| d.rows.clone())
        .unwrap_or_default();

    if rows.is_empty() {
        logs.push(format!(
            "⚠ This step is set to run once per data row, but \"{}\" has no data rows — the request ran once, as authored",
            test_case.name
        ));
        return RowPlan::Once;
    }

    match choice {
        FanOut::Off => RowPlan::Once,
        FanOut::AllRows => RowPlan::Rows(rows.into_iter().enumerate().collect()),
        FanOut::Rows(wanted) => {
            if wanted.is_empty() {
                return RowPlan::NothingSelected(format!(
                    "No data rows are selected for this step, so nothing ran. Open the node and pick the rows of \"{}\" it should run",
                    test_case.name
                ));
            }
            let selected: Vec<(usize, DataRow)> = rows
                .iter()
                .cloned()
                .enumerate()
                .filter(|(_, row)| wanted.iter().any(|id| *id == row.id))
                .collect();

            let missing: Vec<&str> = wanted
                .iter()
                .filter(|id| !rows.iter().any(|row| &row.id == *id))
                .map(String::as_str)
                .collect();

            if selected.is_empty() {
                return RowPlan::NothingSelected(format!(
                    "None of the {} row(s) selected for this step exist in \"{}\" any more, so nothing ran ({})",
                    wanted.len(),
                    test_case.name,
                    missing.join(", ")
                ));
            }
            if !missing.is_empty() {
                logs.push(format!(
                    "⚠ {} selected data row(s) are no longer in \"{}\" ({}) — nothing ran for them. Open this node and re-pick its rows",
                    missing.len(),
                    test_case.name,
                    missing.join(", ")
                ));
            }
            if rows.iter().any(|row| row.id.trim().is_empty()) {
                logs.push(
                    "⚠ Some data rows have no id and can't be selected individually — open the request's Data tab and save it once to give them ids"
                        .to_string(),
                );
            }
            RowPlan::Rows(selected)
        }
    }
}

/// Teardown nodes in the order their edges imply — "log in as admin, then delete"
/// has to happen in that order, and the order they appear in the graph's node list
/// is whatever the canvas happened to produce.
fn teardown_sequence(flow: &Flow) -> Vec<&GraphNode> {
    let marked: Vec<&GraphNode> = flow.graph_data.nodes.iter().filter(|n| is_teardown(n)).collect();
    let leads_to = |from: &str, to: &str| {
        flow.graph_data.edges.iter().any(|e| e.source == from && e.target == to)
    };

    // A chain starts at a marked node no other marked node points at.
    let mut ordered: Vec<&GraphNode> = Vec::new();
    let mut placed: Vec<&str> = Vec::new();
    for start in marked.iter().filter(|n| {
        !marked.iter().any(|other| other.id != n.id && leads_to(&other.id, &n.id))
    }) {
        let mut current = Some(*start);
        while let Some(node) = current {
            if placed.contains(&node.id.as_str()) {
                break; // a cycle; whatever is left is appended below
            }
            placed.push(&node.id);
            ordered.push(node);
            current = marked
                .iter()
                .find(|next| next.id != node.id && leads_to(&node.id, &next.id))
                .copied();
        }
    }
    // Anything unreachable that way (a cycle, or two disconnected chains) still runs.
    for node in marked {
        if !placed.contains(&node.id.as_str()) {
            ordered.push(node);
        }
    }
    ordered
}

/// Names this flow declares as output variables. A teardown node using one of them
/// must get its value from *this* run: `{{baseUrl}}` legitimately comes from the
/// environment, `{{new_account_id}}` does not.
fn flow_produced_names(flow: &Flow) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    for node in &flow.graph_data.nodes {
        let rows = node.data
            .get("config")
            .and_then(|c| c.get("outputVars"))
            .and_then(|v| v.as_array());
        for row in rows.into_iter().flatten() {
            if let Some(name) = row.get("name").and_then(|v| v.as_str()) {
                let name = name.trim();
                if !name.is_empty() {
                    names.insert(name.to_string());
                }
            }
        }
    }
    names
}

/// Why a teardown node must not be sent, if so.
///
/// Deleting is not something to attempt hopefully. Two ways a teardown request can
/// be aimed at the wrong thing, and both end the same way — skip, and say why:
///
///  * a `{{name}}` that resolved to nothing would go out as a literal; a URL with a
///    brace in it is never what anyone intended.
///  * a name this flow produces, but whose value came from the environment, is a
///    leftover from an earlier run — it names a real resource this run never
///    created, and deleting it would be destroying a stranger's data.
fn teardown_blocked(
    test_case: &TestCase,
    ctx: &ExecutionContext,
    produced: &std::collections::HashSet<String>,
    // Anything else this run will put on the wire — a fan-out row's own body and URL
    // suffix, which the test case knows nothing about. Left out, a row could aim a
    // delete at a leftover id and slip past the guard entirely.
    extra_templates: &[&str],
) -> Option<String> {
    let mut templates: Vec<&str> = vec![test_case.endpoint.as_str()];
    templates.extend(extra_templates);
    if let Some(map) = test_case.headers.as_object() {
        templates.extend(map.values().filter_map(|v| v.as_str()));
    }
    if let Some(payload) = test_case.payload.as_deref() {
        templates.push(payload);
    }

    for template in templates {
        for (name, source, _) in ctx.provenance_all(template) {
            match source {
                None => {
                    return Some(format!(
                        "Not run: {{{{{}}}}} was never produced by this run, so this request would go out with a placeholder in it",
                        name
                    ))
                }
                Some(VarSource::Environment) if produced.contains(&name) => {
                    return Some(format!(
                        "Not run: {} came from environment/globals, not from this run — it is a leftover naming something this run never created",
                        name
                    ))
                }
                _ => {}
            }
        }
    }
    None
}

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
    /// This node's own Expect, when the author gave it one. A node states what
    /// should be true for its place in the flow — the same request may be a 202
    /// in one scenario and a 402 in another — and like a dataset row it stands
    /// alone: the test case's post-test script does not run for that node.
    node_check: Option<&'a str>,
}

/// The only differences between the editor's "Run dataset" and a flow node running one
/// request per row. Everything else about iterating rows — cloning the context, folding
/// `SAT.env` forward, the worst-of verdict, the `[row] ` log prefix — lives in
/// `run_rows` and only there, so the two paths cannot drift.
struct RowRunOptions<'a> {
    /// "direct" for the editor path, the node id for the flow path.
    node_id: &'a str,
    /// Node-level `outputVars`. Empty for a fan-out node: rows are isolated clones, so
    /// nothing a row captures would survive to be exported.
    extra_exports: &'a [ExportVariable],
    /// This node's Expect, applied to any row that hasn't stated one of its own.
    node_check: Option<&'a str>,
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
    /// What this node is called on the canvas, when the author named it. Two nodes
    /// can share one test case in different roles ("Login as new user" vs "Root
    /// login"), and a result that says only "Login" can't tell them apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_label: Option<String>,
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
    /// Set on a node that runs as teardown, so a cleanup problem is never mistaken
    /// for the scenario failing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teardown: Option<bool>,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        node_label: Option<String>,
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

        // Teardown: runs however the path above ended — passed, failed, or stopped
        // dead on an error. That is the whole point: an account created by a run
        // that then broke still has to be cleaned up.
        let produced = flow_produced_names(flow);
        for node in teardown_sequence(flow) {
            if node.node_type != "testCase" {
                continue;
            }
            let mut result = self
                .execute_test_case_node(node, tc_repo, &mut tc_cache, &mut ctx, &event_tx, Some(&produced))
                .await;
            result.teardown = Some(true);
            match result.status {
                NodeStatus::Passed => stats.passed += 1,
                NodeStatus::Failed => stats.failed += 1,
                NodeStatus::Error => stats.errors += 1,
                NodeStatus::Skipped => stats.skipped += 1,
            }
            if let Some(tx) = &event_tx {
                let _ = tx.send(ExecutionEvent::NodeCompleted {
                    node_id: node.id.clone(),
                    result: result.clone(),
                }).await;
            }
            results.push(result);
        }

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
                    node, tc_repo, tc_cache, ctx, event_tx, None
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
        // Set only for a teardown run: the names this flow produces, against which
        // the request is checked before anything is sent.
        teardown_guard: Option<&std::collections::HashSet<String>>,
    ) -> NodeResult {
        let start = std::time::Instant::now();
        let mut logs = Vec::new();

        // The canvas name for this node, when the author gave it one. Blank counts
        // as unnamed: an empty title would just erase the test case name downstream.
        let node_label = node.data.get("alias")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        // Extract test case ID from node data
        let tc_id = node.data.get("testCaseId")
            .or_else(|| node.data.get("test_case_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let tc_id = match tc_id {
            Some(id) => id,
            None => {
                return NodeResult {
                    node_label: node_label.clone(),
                    node_id: node.id.clone(),
                    teardown: None,
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
                        node_label: node_label.clone(),
                        node_id: node.id.clone(),
                        teardown: None,
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
                        node_label: node_label.clone(),
                        node_id: node.id.clone(),
                        teardown: None,
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
                node_label: node_label.clone(),
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

        // Teardown only: check what this request would be aimed at before sending
        // it. Checked *after* node input vars are set, so a value supplied on the
        // node counts as coming from the node.
        // Planned before the teardown guard, so the guard can inspect what a row would
        // actually send, and reused below rather than planned twice.
        let plan = plan_rows(node, &test_case, &mut logs);

        if let Some(produced) = teardown_guard {
            let row_templates: Vec<&str> = match &plan {
                RowPlan::Rows(rows) => rows
                    .iter()
                    .flat_map(|(_, row)| {
                        [row.body_override(), row.path_suffix()].into_iter().flatten()
                    })
                    .collect(),
                _ => Vec::new(),
            };
            if let Some(reason) = teardown_blocked(&test_case, ctx, produced, &row_templates) {
                logs.push(reason.clone());
                return NodeResult {
                    node_id: node.id.clone(),
                    node_label,
                    teardown: Some(true),
                    test_case_id: Some(test_case.id.clone()),
                    test_case_name: Some(test_case.name.clone()),
                    status: NodeStatus::Skipped,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: None,
                    response: None,
                    exports: None,
                    env: None,
                    error_message: Some(reason),
                    logs,
                    row_index: None,
                    row_label: None,
                    iterations: None,
                };
            }
        }

        // Accumulates SAT.env writes from pre-test + assertion scripts (persisted by the client)
        let mut env_writes: HashMap<String, Value> = HashMap::new();

        // Node-level outputVars merge with the test case's own exports. A row that
        // is only half filled in used to be dropped in silence, and the only symptom
        // was {{name}} arriving literally at some later node — so say so here.
        let mut node_output_vars: Vec<ExportVariable> = Vec::new();
        if let Some(rows) = node.data
            .get("config")
            .and_then(|c| c.get("outputVars"))
            .and_then(|v| v.as_array())
        {
            for row in rows {
                let field = |key: &str| {
                    row.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
                };
                let (name, path) = (field("name"), field("path"));
                match (name.is_empty(), path.is_empty()) {
                    (false, false) => node_output_vars
                        .push(ExportVariable { name, json_path: path }),
                    (false, true) => logs.push(format!(
                        "⚠ Output variable \"{}\" has no JSON path, so nothing was \
                         captured — {{{{{}}}}} will not resolve",
                        name, name
                    )),
                    (true, false) => logs.push(format!(
                        "⚠ Output variable with path {} has no name, so nothing was captured",
                        path
                    )),
                    // A blank row the author just added and hasn't filled in.
                    (true, true) => {}
                }
            }
        }

        // This node's Expect, when the author gave it one.
        let node_check = node.data
            .get("config")
            .and_then(|c| c.get("check"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        // Once, or once per data row? Decided here rather than in run_once, because a
        // fan-out sends N requests and run_once is the one-request cycle.
        let mut result = match plan {
            RowPlan::Once => {
                self.run_once(
                    &test_case,
                    None,
                    ctx,
                    RunOptions {
                        node_id: &node.id,
                        extra_exports: &node_output_vars,
                        node_check,
                        // Was false here and true on the standalone path —
                        // unintentional drift. An unresolved {{var}} shipping as a
                        // literal is worth saying out loud wherever it happens; in a
                        // flow it is the likelier place, since the value was supposed
                        // to come from an earlier node.
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

            RowPlan::Rows(rows) => {
                // Rows are isolated clones, so nothing a row captures survives the
                // step. Left unsaid, the only symptom is {{name}} arriving literally at
                // a later node — the failure mode this codebase keeps paying for.
                if !node_output_vars.is_empty() {
                    logs.push(format!(
                        "⚠ This step runs once per data row, so nothing is carried forward: output variable(s) {} were not captured. Capture on a step that runs once",
                        node_output_vars
                            .iter()
                            .map(|e| e.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if !test_case.exports.is_empty() {
                    logs.push(format!(
                        "⚠ \"{}\"'s own exports are captured per row but do not survive this step — rows are isolated",
                        test_case.name
                    ));
                }
                self.run_rows(
                    &test_case,
                    &rows,
                    ctx,
                    RowRunOptions {
                        node_id: &node.id,
                        extra_exports: &[],
                        node_check,
                    },
                    logs,
                    &mut env_writes,
                    start,
                )
                .await
            }

            RowPlan::NothingSelected(reason) => {
                logs.push(reason.clone());
                NodeResult {
                    node_id: node.id.clone(),
                    node_label: None,
                    teardown: None,
                    test_case_id: Some(test_case.id.clone()),
                    test_case_name: Some(test_case.name.clone()),
                    // Failed, not Error: nothing broke, the step was mis-configured —
                    // and Failed routes down the failure edge instead of ending the run.
                    status: NodeStatus::Failed,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: None,
                    response: None,
                    exports: None,
                    env: None,
                    error_message: Some(reason),
                    logs,
                    row_index: None,
                    row_label: None,
                    iterations: None,
                }
            }
        };
        result.node_label = node_label;
        result
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
            None => {
                // Exports were configured against a body that isn't JSON. Silence
                // here reads as "extracted fine" and the names never resolve.
                logs.push(format!(
                    "⚠ Response is not JSON, so nothing was extracted for: {}",
                    all_exports.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", ")
                ));
                return None;
            }
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
                    } else {
                        // A path that matches nothing used to look exactly like a
                        // path that worked. One typo ("$.accesss_token") then shows
                        // up much later as a literal {{name}} in another request, so
                        // name what the body actually offered.
                        logs.push(format!(
                            "⚠ Export \"{}\": nothing at {}{} — {{{{{}}}}} will not resolve",
                            export.name,
                            export.json_path,
                            top_level_keys(json),
                            export.name
                        ));
                    }
                }
                Err(e) => logs.push(format!(
                    "⚠ Export \"{}\" has an unusable path {}: {}",
                    export.name, export.json_path, e
                )),
            }
        }

        if exported.is_empty() {
            None
        } else {
            Some(exported)
        }
    }

    /// Find the next node to execute based on edge type
    /// The next node to run, stepping over any teardown node in the way.
    ///
    /// Teardown nodes are not part of the path — they run after it — but one may sit
    /// anywhere in the chain the author drew. Simply refusing to walk into it would
    /// end the traversal there and silently drop everything downstream, so the chain
    /// closes over the gap instead.
    fn find_next_node(&self, flow: &Flow, current_id: &str, preferred_type: Option<&str>) -> Option<String> {
        let is_marked = |id: &str| {
            flow.graph_data.nodes.iter().any(|n| n.id == id && is_teardown(n))
        };
        let mut from = current_id.to_string();
        // The node count bounds the walk: a cycle of teardown nodes can't spin here.
        for _ in 0..=flow.graph_data.nodes.len() {
            let target = self.pick_edge(flow, &from, preferred_type)?;
            if !is_marked(&target) {
                return Some(target);
            }
            from = target;
        }
        None
    }

    /// Which edge to take out of a node, ignoring what the target is.
    fn pick_edge(&self, flow: &Flow, current_id: &str, preferred_type: Option<&str>) -> Option<String> {
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
                    node_label: None,
                    node_id: opts.node_id.to_string(),
                    teardown: None,
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
                        logs.extend(outcome.output);
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
                    Err(e) => bail!(format!("Pre-test script failed: {}", plain(&e)), None, None),
                }
            }
        }

        // The endpoint this row asks for — the test case's, plus the row's own suffix.
        // Composed once here and used by the interpolation *and* every diagnostic
        // below, so a row's {{org}} is visible to all of them.
        let endpoint_template = resolve_endpoint(row, test_case);

        // Interpolate endpoint URL and prepend base URL if needed
        let endpoint = match ctx.interpolate(&endpoint_template) {
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

            // A name that resolved to the text "null" looks fine in the request and
            // is invisible to the check above — it resolved. Almost always a
            // leftover in Globals or an environment. Read from the templates, since
            // by now the value is indistinguishable from a legitimate "null".
            let mut placeholders: Vec<String> = ctx.placeholder_values(&endpoint_template);
            if let Some(map) = test_case.headers.as_object() {
                for value in map.values() {
                    if let Some(text) = value.as_str() {
                        placeholders.extend(ctx.placeholder_values(text));
                    }
                }
            }
            if let Some(template) = resolve_body(row, test_case) {
                placeholders.extend(ctx.placeholder_values(template));
            }
            placeholders.sort();
            placeholders.dedup();
            if !placeholders.is_empty() {
                logs.push(format!(
                    "⚠ Variable(s) resolved to the text \"null\": {} — check Globals and \
                     the active environment for a leftover value",
                    placeholders.join(", ")
                ));
            }
        }

        // In debug mode, say where each {{name}} came from. A value that resolves
        // from the environment when this run was supposed to produce it looks
        // completely normal in the request — it is the one failure no warning can
        // detect, so the answer is to show the tier and let the author see it.
        if self.debug_mode {
            let mut seen: Vec<String> = Vec::new();
            let mut templates: Vec<&str> = vec![endpoint_template.as_ref()];
            if let Some(map) = test_case.headers.as_object() {
                templates.extend(map.values().filter_map(|v| v.as_str()));
            }
            if let Some(body_template) = resolve_body(row, test_case) {
                templates.push(body_template);
            }
            for template in templates {
                for (name, source, value) in ctx.provenance(template) {
                    if seen.contains(&name) {
                        continue;
                    }
                    seen.push(name.clone());
                    logs.push(format!("{} ← {} = {}", name, source.label(), value));
                }
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

        // Where the verdict comes from, most specific first:
        //
        //  * a dataset row's Expect,
        //  * else this node's Expect (its role in the flow: 202 here, 402 there),
        //  * else the test case's post-test script.
        //
        // The first two stand alone — the shared script does not run for them. The
        // author has said what should be true for this row or this step, and a
        // script written for the request in isolation can neither decide nor break
        // it. Nothing is lost: output variables run either way, and an Expect can
        // capture for itself.
        // A row's Expect wins; when a row hasn't stated one, this node's applies. That
        // middle step is what lets one dataset serve two scenarios: the rows describe
        // the request, and the node says what its actor should get back — a listing that
        // is 200 for a super user and 403 for an org admin.
        let stated_check: Option<(Option<String>, &str)> = match row {
            Some(data_row) => Some(match data_row.check_expr() {
                Some(expr) => (Some(expr.to_string()), "This row's check"),
                None => (opts.node_check.map(str::to_string), "This node's check"),
            }),
            None => opts.node_check.map(|c| (Some(c.to_string()), "This node's check")),
        };

        // A check is interpolated, like the URL, headers and body already are — it was
        // the one string that wasn't. That's what lets a row state the shape of the
        // truth once and each node supply the actor's value:
        //
        // response.json.items.len() == {{expected_count}}
        //
        // Strings keep the body convention: `response.json.org == "{{org_id}}"`. An
        // unresolved name stays literal, so the ⚠ warning fires rather than the check
        // quietly comparing against nothing.
        let own_check = stated_check.map(|(raw, what)| {
            (raw.map(|text| ctx.interpolate(&text).unwrap_or(text)), what)
        });

        let assertion_passed = match own_check {
            Some((ref raw, what)) => {
                let passed = match parse_check(raw.as_deref()) {
                    Check::Status(expected) => {
                        let ok = status_code == expected;
                        if !ok {
                            assertion_failure =
                                Some(format!("Expected HTTP {}, got {}", expected, status_code));
                        }
                        ok
                    }
                    Check::Expr(expr) => match self.assertions.evaluate(AssertionInput {
                        script: expr,
                        status: status_code,
                        body: &http_result.response.body,
                        json: &http_result.response.json,
                        headers: &http_result.response.headers,
                        env: &ctx.environment_snapshot(),
                    }) {
                        Ok(outcome) => {
                            logs.extend(outcome.output);
                            // A check may capture on its way to a verdict.
                            for (k, v) in outcome.vars {
                                ctx.set(&k, v);
                            }
                            for (k, v) in outcome.env {
                                ctx.set_environment_var(&k, v.clone());
                                env_writes.insert(k, v);
                            }
                            match outcome.passed {
                                Some(true) => true,
                                Some(false) => {
                                    assertion_failure = Some(format!(
                                        "Check returned false: {}  (actual: HTTP {})",
                                        last_expression(expr), status_code
                                    ));
                                    false
                                }
                                // Not a yes/no answer — say so rather than guessing.
                                None => {
                                    assertion_failure = Some(format!(
                                        "{} must be a status code or an expression that is \
                                         true or false — got: {}",
                                        what,
                                        last_expression(expr)
                                    ));
                                    false
                                }
                            }
                        }
                        Err(e) => bail!(
                            format!("{} could not run: {}", what, plain(&e)),
                            Some(http_result.request),
                            Some(http_result.response)
                        ),
                    },
                    Check::Unstated => {
                        let ok = AssertionEngine::default_assertion(status_code);
                        if !ok {
                            assertion_failure = Some(format!(
                                "No check given, so a 2xx was required — got HTTP {}",
                                status_code
                            ));
                        }
                        ok
                    }
                };
                if let Some(ref reason) = assertion_failure {
                    logs.push(reason.clone());
                }
                passed
            }
            None => {
                // Post-test script: runs for its side effects (SAT.vars / SAT.env)
                // and decides the verdict when it ends in a boolean.
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
                            logs.extend(outcome.output);
                            for (k, v) in outcome.vars {
                                ctx.set(&k, v);
                            }
                            for (k, v) in outcome.env {
                                ctx.set_environment_var(&k, v.clone());
                                env_writes.insert(k, v);
                            }
                        }
                        // The script couldn't run at all — a defect in the test, not
                        // a failed check. Don't persist whatever it wrote before
                        // throwing: half-captured values poison later runs.
                        Err(e) => bail!(
                            format!("Post-test script could not run: {}", plain(&e)),
                            Some(http_result.request),
                            Some(http_result.response)
                        ),
                    }
                }

                match script_verdict {
                    Some(verdict) => {
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
                    // No boolean to judge by — a capture-only script is legitimate —
                    // so fall back to the same rule a dataset row uses.
                    None => {
                        let ok = AssertionEngine::default_assertion(status_code);
                        if !ok {
                            let reason = format!(
                                "Assertion failed: expected a 2xx status, got HTTP {}",
                                status_code
                            );
                            logs.push(reason.clone());
                            assertion_failure = Some(reason);
                        }
                        ok
                    }
                }
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
            node_label: None,
            node_id: opts.node_id.to_string(),
            teardown: None,
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
        let rows: Vec<(usize, DataRow)> = test_case
            .dataset
            .as_ref()
            .map(|d| d.rows.iter().cloned().enumerate().collect())
            .unwrap_or_default();

        let mut base_ctx = ExecutionContext::new(variables, environment, HashMap::new());
        let mut env_writes: HashMap<String, Value> = HashMap::new();

        self.run_rows(
            test_case,
            &rows,
            &mut base_ctx,
            RowRunOptions { node_id: "direct", extra_exports: &[], node_check: None },
            Vec::new(),
            &mut env_writes,
            start,
        )
        .await
    }

    /// Run one request per row against `base_ctx`, folded into one aggregate result
    /// whose `iterations` holds the per-row results.
    ///
    /// Each row gets a *clone* of the base context, so exports and pre-test vars can't
    /// leak between rows while every row still sees whatever the caller's context
    /// already holds — which is how a row inherits an earlier node's JWT. `SAT.env`
    /// writes are folded forward, so a later row does see what an earlier one
    /// persisted. Rows run sequentially and a failing row never stops the rest.
    ///
    /// Rows carry their index *in the dataset*, so a selected subset is still labelled
    /// and ordered the way the editor's matrix shows it.
    ///
    /// Deliberately sequential: the `SAT.env` fold is order-dependent, and the Rhai
    /// engines share a thread-local `print()` sink (`execution/script_log.rs`), so
    /// concurrent rows would file their output under the wrong result.
    async fn run_rows(
        &self,
        test_case: &TestCase,
        rows: &[(usize, DataRow)],
        base_ctx: &mut ExecutionContext,
        opts: RowRunOptions<'_>,
        logs: Vec<String>,
        env_writes: &mut HashMap<String, Value>,
        start: std::time::Instant,
    ) -> NodeResult {
        let mut iterations: Vec<NodeResult> = Vec::with_capacity(rows.len());
        let mut logs = logs;

        info!("Running \"{}\" over {} data row(s)", test_case.name, rows.len());

        for (index, row) in rows {
            let label = crate::db::models::Dataset::label_for(*index, row);
            let mut row_ctx = base_ctx.clone();
            let mut row_env: HashMap<String, Value> = HashMap::new();

            let result = self
                .run_once(
                    test_case,
                    Some(row),
                    &mut row_ctx,
                    RunOptions {
                        node_id: opts.node_id,
                        node_check: opts.node_check,
                        extra_exports: opts.extra_exports,
                        report_unresolved: true,
                        row_index: Some(*index),
                        row_label: Some(label.clone()),
                    },
                    Vec::new(),
                    &mut row_env,
                    std::time::Instant::now(),
                )
                .await;

            // Carry SAT.env writes forward to later rows and out to the caller.
            for (k, v) in row_env {
                base_ctx.set_environment_var(&k, v.clone());
                env_writes.insert(k, v);
            }
            iterations.push(result);
        }

        // No rows at all would fold to `Passed` having sent nothing — the worst kind of
        // green. Neither caller should reach this, which is why it's worth stating.
        if iterations.is_empty() {
            logs.push("No data rows to run".to_string());
            return NodeResult {
                node_id: opts.node_id.to_string(),
                teardown: None,
                node_label: None,
                test_case_id: Some(test_case.id.clone()),
                test_case_name: Some(test_case.name.clone()),
                status: NodeStatus::Failed,
                duration_ms: start.elapsed().as_millis() as u64,
                request: None,
                response: None,
                exports: None,
                env: None,
                error_message: Some("No data rows to run".to_string()),
                logs,
                row_index: None,
                row_label: None,
                iterations: Some(Vec::new()),
            };
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

        // The caller's own notes first, unprefixed; then each row's, prefixed, so a flat
        // log view still says which row spoke.
        logs.extend(iterations.iter().flat_map(|r| {
            let label = r.row_label.clone().unwrap_or_default();
            r.logs.iter().map(move |l| format!("[{}] {}", label, l))
        }));

        NodeResult {
            node_id: opts.node_id.to_string(),
            teardown: None,
            // Set by the flow path, which knows the node; a dataset run from the editor
            // has no node to name.
            node_label: None,
            test_case_id: Some(test_case.id.clone()),
            test_case_name: Some(test_case.name.clone()),
            status,
            duration_ms: start.elapsed().as_millis() as u64,
            // Deliberately None: an aggregate has no single request/response, and
            // the UI branches on `iterations` to render the per-row matrix.
            request: None,
            response: None,
            exports: None,
            env: if env_writes.is_empty() { None } else { Some(env_writes.clone()) },
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
                node_check: None,
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
                    path: None,
                    id: format!("r{}", i),
                    name: Some(name.to_string()),
                    body: body.map(str::to_string),
                    check: status.map(str::to_string),
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

    #[test]
    fn test_row_check_forms() {
        // The shorthand and the expression form are told apart by whether the check
        // is nothing but digits.
        let shorthand = DataRow { check: Some("409".into()), ..Default::default() };
        assert_eq!(shorthand.expected_status_code(), Some(409));

        let expression = DataRow {
            check: Some("response.json.token != ()".into()),
            ..Default::default()
        };
        assert_eq!(expression.expected_status_code(), None);
        assert_eq!(expression.check_expr(), Some("response.json.token != ()"));
    }

    #[tokio::test]
    async fn test_dataset_rows_ignore_the_shared_post_test_script() {
        // The Data tab stands alone: a post-test script written for the
        // single-request case must not run during a dataset run, so it can neither
        // decide nor break a row's verdict. Proven with a script that cannot even
        // parse — if it ran, the row would come back as an error.
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc1", "SignUp", "http://127.0.0.1:1/u", "POST");
        tc.assertion_script = Some("this is not valid rhai at all".to_string());
        tc.dataset = Some(dataset_of(vec![("row", Some("{}"), Some("400"))]));

        let result = engine
            .execute_test_case_dataset(&tc, HashMap::new(), HashMap::new())
            .await;
        let it = &result.iterations.as_ref().unwrap()[0];

        // The request can't connect here, so the verdict isn't reachable — what
        // matters is that we failed on the connection, not on the script.
        let msg = it.error_message.clone().unwrap_or_default();
        assert!(msg.contains("HTTP request failed"), "unexpected failure: {msg}");
        assert!(
            !msg.contains("script"),
            "the shared script must not be involved in a dataset run: {msg}"
        );
    }

    #[tokio::test]
    async fn a_node_not_marked_for_rows_ignores_the_dataset() {
        // A flow runs the test case as authored — once, with no row applied — unless
        // the node says otherwise. Adding a dataset never changes an existing flow.
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

    /// A one-shot HTTP server that answers with the given status and body. The
    /// other tests here point at a refused port, which is fine when only the
    /// request log matters — but a verdict needs a real response to judge.
    /// A stub that answers `times` requests before closing. Fan-out sends one request
    /// per row, so a single-shot stub would leave later rows with a refused connection
    /// — which errors before any verdict and hides what the test is checking.
    async fn stub_times(status: u16, body: &'static str, times: usize) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..times {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 8192];
                let _ = socket.read(&mut buf).await; // drain the request
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, body.len(), body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{}/", addr)
    }

    async fn stub_once(status: u16, body: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await; // drain the request
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, body.len(), body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{}/sms", addr)
    }

    /// A teardown node may sit anywhere the author drew it. Marking one in the
    /// middle of a chain must lift it out, not cut the chain: the first version of
    /// this ended the traversal at the node before it and dropped the rest of the
    /// flow without a word.
    #[tokio::test]
    async fn a_teardown_node_mid_chain_does_not_sever_the_flow() {
        let engine = ExecutionEngine::new(false, None);
        // A and C must actually pass, or the flow stops for an unrelated reason —
        // a refused port is an *error*, which ends traversal by design.
        let a = make_test_case("a", "A", &stub_once(200, "{}").await, "POST");
        let c = make_test_case("c", "C", &stub_once(200, "{}").await, "POST");
        let t = make_test_case("t", "Cleanup", "http://127.0.0.1:1/t", "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(a).with_test_case(t).with_test_case(c);
        // start → A → [Cleanup, marked teardown] → C → end
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("c", "testCase", serde_json::json!({"testCaseId": "c"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "t", Some("success")),
            make_edge("e3", "t", "c", Some("success")),
            make_edge("e4", "c", "end", Some("success")),
        ]);
        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await.unwrap().results;
        let names: Vec<&str> = results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        // C still runs, and Cleanup runs at the end rather than in place.
        assert_eq!(names, vec!["A", "C", "Cleanup"], "{:?}", names);
    }

    // ===================== fan-out: a dataset inside a flow =====================

    /// A row that couldn't run at all is systemic, not a per-case outcome — so the
    /// aggregate is Error and the flow stops. Cleanup still happens, which is what makes
    /// stopping safe rather than destructive.
    #[tokio::test]
    async fn one_errored_row_stops_the_flow_but_teardown_still_runs() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![("one", Some("{}"), None), ("two", Some("{}"), None)]));
        let after = make_test_case("after", "Downstream", &stub_once(200, "{}").await, "POST");
        let cleanup = make_test_case("cleanup", "Cleanup", &stub_once(200, "{}").await, "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(tc)
            .with_test_case(after)
            .with_test_case(cleanup);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("b", "testCase", serde_json::json!({
                "testCaseId": "tc", "config": {"forEachRow": true}
            })),
            make_node("c", "testCase", serde_json::json!({"testCaseId": "after"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "cleanup", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "b", None),
            make_edge("e2", "b", "c", Some("success")),
            make_edge("e3", "c", "end", Some("success")),
        ]);

        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let fanned = results.iter().find(|r| r.node_id == "b").unwrap();
        assert_eq!(fanned.status, NodeStatus::Error);
        assert!(results.iter().all(|r| r.node_id != "c"), "the flow stopped");
        let cleanup = results.iter().find(|r| r.node_id == "t").expect("cleanup still ran");
        assert_eq!(cleanup.teardown, Some(true));
    }

    /// A fan-out teardown node is guarded per row: a row's own body or URL suffix could
    /// aim a delete at a leftover id the test case knows nothing about.
    #[tokio::test]
    async fn a_fanned_out_teardown_node_is_still_guarded() {
        let engine = ExecutionEngine::new(false, None);
        let mut del = make_test_case("del", "Delete", "http://127.0.0.1:1/accounts", "DELETE");
        let mut dataset = dataset_of(vec![("by id", None, None)]);
        // The id lives in the row's URL suffix, not in the test case's endpoint.
        dataset.rows[0].path = Some("/{{new_account_id}}".to_string());
        del.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(del);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({
                "testCaseId": "del",
                "config": {"outputVars": [{"name": "new_account_id", "path": "$.id"}]}
            })),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "del", "config": {"teardown": true, "forEachRow": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "end", Some("success")),
        ]);

        // new_account_id is declared by node "a" but never produced (it errors), so the
        // teardown row must not be sent.
        let mut env = HashMap::new();
        env.insert("new_account_id".to_string(), serde_json::json!("acct-from-a-previous-run"));
        let results = engine
            .execute_flow("exec1", &flow, &repo, env, HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let cleanup = results.iter().find(|r| r.node_id == "t").expect("teardown was reached");
        assert_eq!(cleanup.status, NodeStatus::Skipped);
        assert!(cleanup.request.is_none(), "a stale id must never be deleted");
        assert!(
            cleanup.error_message.as_deref().unwrap_or("").contains("environment/globals"),
            "{:?}",
            cleanup.error_message
        );
    }


    /// `start → b → end`, where `b` carries `config`. One node, so nothing upstream
    /// can consume a stub's response or abort traversal before the fan-out runs.
    fn one_node_flow(tc_id: &str, config: serde_json::Value) -> Flow {
        let mut data = serde_json::json!({"testCaseId": tc_id});
        if let Some(o) = data.as_object_mut() { o.insert("config".into(), config); }
        make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("b", "testCase", data),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "b", None),
            make_edge("e2", "b", "end", Some("success")),
        ])
    }

    /// Build `start → a → b → end`, where `b` carries `config`.
    fn fan_out_flow(a_id: &str, b_id: &str, a_config: serde_json::Value, b_config: serde_json::Value) -> Flow {
        let mut a_data = serde_json::json!({"testCaseId": a_id});
        let mut b_data = serde_json::json!({"testCaseId": b_id});
        if let Some(o) = a_data.as_object_mut() { o.insert("config".into(), a_config); }
        if let Some(o) = b_data.as_object_mut() { o.insert("config".into(), b_config); }
        make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", a_data),
            make_node("b", "testCase", b_data),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "b", Some("success")),
            make_edge("e3", "b", "end", Some("success")),
        ])
    }

    #[test]
    fn an_absent_row_list_means_every_row() {
        let off = make_node("n", "testCase", serde_json::json!({}));
        assert_eq!(fan_out(&off), FanOut::Off);

        let all = make_node("n", "testCase", serde_json::json!({"config": {"forEachRow": true}}));
        assert_eq!(fan_out(&all), FanOut::AllRows);

        // An empty list is not "all" — it is "none", and the node says so.
        let none = make_node("n", "testCase", serde_json::json!({
            "config": {"forEachRow": true, "rowIds": []}
        }));
        assert_eq!(fan_out(&none), FanOut::Rows(vec![]));

        // Blanks dropped, duplicates collapsed.
        let some = make_node("n", "testCase", serde_json::json!({
            "config": {"forEachRow": true, "rowIds": ["r1", "  ", "r1", " r0 "]}
        }));
        assert_eq!(fan_out(&some), FanOut::Rows(vec!["r1".into(), "r0".into()]));
    }

    /// The whole point of the feature: a row inherits what an earlier node produced.
    /// Without this, a dataset can only ever test requests that need no setup.
    #[tokio::test]
    async fn a_fanned_out_row_sees_what_an_earlier_node_produced() {
        let engine = ExecutionEngine::new(false, None);

        let login = make_test_case("login", "Login", &stub_once(200, r#"{"token":"T-42"}"#).await, "POST");
        let mut sms = make_test_case("sms", "Send SMS", &stub_times(200, "{}", 2).await, "POST");
        sms.headers = serde_json::json!({"Authorization": "Bearer {{token}}"});
        sms.dataset = Some(dataset_of(vec![
            ("first", Some(r#"{"n":1}"#), None),
            ("second", Some(r#"{"n":2}"#), None),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(login).with_test_case(sms);

        let flow = fan_out_flow(
            "login",
            "sms",
            serde_json::json!({"outputVars": [{"name": "token", "path": "$.token"}]}),
            serde_json::json!({"forEachRow": true}),
        );
        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let fanned = results.iter().find(|r| r.node_id == "b").expect("the sms node ran");
        let rows = fanned.iterations.as_ref().expect("one result per row");
        assert_eq!(rows.len(), 2);
        for row in rows {
            let auth = row.request.as_ref().unwrap().headers.get("Authorization");
            assert_eq!(auth.map(String::as_str), Some("Bearer T-42"), "{:?}", row.row_label);
        }
        assert_eq!(fanned.status, NodeStatus::Passed);
    }

    #[tokio::test]
    async fn a_node_can_run_a_chosen_subset_of_rows() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![
            ("one", Some(r#"{"n":1}"#), None),
            ("two", Some(r#"{"n":2}"#), None),
            ("three", Some(r#"{"n":3}"#), None),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        // Selected out of order on purpose: results come back in dataset order.
        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "rowIds": ["r2", "r0"]
        }));
        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let rows = results.iter().find(|r| r.node_id == "b").unwrap().iterations.clone().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter().map(|r| r.row_index).collect::<Vec<_>>(),
            vec![Some(0), Some(2)],
            "dataset order, not selection order"
        );
    }

    #[tokio::test]
    async fn a_selected_row_that_no_longer_exists_is_named_not_dropped() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![("one", Some("{}"), None)]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "rowIds": ["r0", "ghost"]
        }));
        let node = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        // The surviving row still runs — a stale id doesn't cancel real work.
        assert_eq!(node.iterations.as_ref().unwrap().len(), 1);
        let logs = node.logs.join("\n");
        assert!(logs.contains("ghost"), "{}", logs);
        assert!(logs.contains("no longer"), "{}", logs);
    }

    #[tokio::test]
    async fn a_selection_that_matches_nothing_fails_the_node() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![("one", Some("{}"), None)]));
        let repo = MockTestCaseRepository::new().with_test_case(tc.clone());

        for row_ids in [serde_json::json!(["ghost"]), serde_json::json!([])] {
            let flow = one_node_flow("tc", serde_json::json!({
                "forEachRow": true, "rowIds": row_ids
            }));
            let node = engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap()
                .results
                .into_iter()
                .find(|r| r.node_id == "b")
                .unwrap();

            // Failed, not Error: nothing broke, and the request must not be sent as
            // authored — that would be a different test reported as this one.
            assert_eq!(node.status, NodeStatus::Failed);
            assert!(node.request.is_none(), "nothing may be sent");
            assert!(node.iterations.is_none(), "an empty matrix is worse than none");
            assert!(
                node.error_message.as_deref().unwrap_or("").contains("nothing ran"),
                "{:?}",
                node.error_message
            );
        }
    }

    #[tokio::test]
    async fn a_node_marked_for_rows_on_a_request_without_any_runs_once() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", &stub_once(200, "{}").await, "POST");
        tc.payload = Some(r#"{"authored":true}"#.to_string());
        tc.dataset = None;
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({"forEachRow": true}));
        let node = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        assert!(node.iterations.is_none());
        assert_eq!(
            node.request.as_ref().unwrap().body.as_deref(),
            Some(r#"{"authored":true}"#)
        );
        assert!(node.logs.join("\n").contains("no data rows"), "{:?}", node.logs);
    }

    /// A row with no Expect of its own falls back to the node's — which is what lets one
    /// dataset serve two actors: 200 for a super user, 403 for an org admin.
    #[tokio::test]
    async fn a_row_without_its_own_expect_falls_back_to_the_nodes() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "List", &stub_times(403, "{}", 2).await, "GET");
        tc.dataset = Some(dataset_of(vec![
            ("inherits the node's", None, None),
            ("states its own", None, Some("200")),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "check": "403"
        }));
        let rows = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        assert_eq!(rows[0].status, NodeStatus::Passed, "{:?}", rows[0].error_message);
        // The row's own Expect still wins over the node's.
        assert_eq!(rows[1].status, NodeStatus::Failed);
    }

    /// The actor-varying case: one Expect authored on the row, each node supplying the
    /// value. Impossible until a check was interpolated like the URL and body already are.
    #[tokio::test]
    async fn a_check_can_be_parameterised_by_a_node_input_var() {
        async fn verdict(expected: &str) -> NodeStatus {
            let engine = ExecutionEngine::new(false, None);
            let mut tc = make_test_case("tc", "List", &stub_once(200, r#"{"n":3}"#).await, "GET");
            tc.dataset = Some(dataset_of(vec![(
                "count depends on who is asking",
                None,
                Some("response.json.n == {{expected_count}}"),
            )]));
            let repo = MockTestCaseRepository::new().with_test_case(tc);
            let flow = one_node_flow("tc", serde_json::json!({
                "forEachRow": true,
                "inputVars": [{"key": "expected_count", "value": expected}]
            }));
            engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap()
                .results
                .into_iter()
                .find(|r| r.node_id == "b")
                .unwrap()
                .iterations
                .unwrap()
                .remove(0)
                .status
        }

        assert_eq!(verdict("3").await, NodeStatus::Passed);
        assert_eq!(verdict("12").await, NodeStatus::Failed);
    }

    #[tokio::test]
    async fn output_variables_on_a_fanned_out_node_say_they_captured_nothing() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Login", &stub_once(200, r#"{"token":"T"}"#).await, "POST");
        tc.dataset = Some(dataset_of(vec![("one", Some("{}"), None)]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true,
            "outputVars": [{"name": "token", "path": "$.token"}]
        }));
        let node = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        let logs = node.logs.join("\n");
        assert!(logs.contains("token"), "{}", logs);
        assert!(logs.contains("nothing is carried forward"), "{}", logs);
        assert!(node.exports.is_none(), "a fan-out node exports nothing");
    }

    #[tokio::test]
    async fn a_row_can_extend_the_endpoint() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "List", "http://127.0.0.1:1/campaigns", "GET");
        let mut dataset = dataset_of(vec![("own org", None, None), ("all orgs", None, None)]);
        dataset.rows[0].path = Some("?org={{my_org}}".to_string());
        dataset.rows[1].path = Some("/all".to_string());
        tc.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true,
            "inputVars": [{"key": "my_org", "value": "acme"}]
        }));
        let rows = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        // A row's suffix is interpolated like the endpoint it extends.
        assert!(rows[0].request.as_ref().unwrap().url.ends_with("/campaigns?org=acme"));
        assert!(rows[1].request.as_ref().unwrap().url.ends_with("/campaigns/all"));
    }

    #[test]
    fn a_rows_query_joins_an_endpoint_that_already_has_one() {
        let mut tc = make_test_case("tc", "List", "http://x/campaigns?limit=10", "GET");
        tc.payload = None;
        let mut row = DataRow { path: Some("?org=acme".into()), ..Default::default() };

        // "?limit=10?org=acme" is a URL the server reads as one broken parameter.
        assert_eq!(resolve_endpoint(Some(&row), &tc), "http://x/campaigns?limit=10&org=acme");

        // A path suffix is appended as-is.
        row.path = Some("/all".into());
        assert_eq!(resolve_endpoint(Some(&row), &tc), "http://x/campaigns?limit=10/all");

        // Blank or absent leaves the endpoint alone.
        row.path = Some("   ".into());
        assert_eq!(resolve_endpoint(Some(&row), &tc), "http://x/campaigns?limit=10");
        assert_eq!(resolve_endpoint(None, &tc), "http://x/campaigns?limit=10");
    }

    /// Teardown exists for the run that broke: an account created by a flow that
    /// then failed still has to be deleted. And it must not fire blind — a DELETE
    /// aimed at a leftover id would destroy something this run never created.
    #[tokio::test]
    async fn teardown_runs_after_a_failure_but_not_blind() {
        /// A flow: signup (may fail) → send, then teardown: admin login → delete.
        async fn run(
            signup_url: &str,
            environment: HashMap<String, Value>,
        ) -> Vec<NodeResult> {
            let engine = ExecutionEngine::new(false, None);
            let mut signup = make_test_case("signup", "Signup", signup_url, "POST");
            signup.assertion_script = Some("response.status == 201".to_string());
            let login = make_test_case("login", "Admin login", "http://127.0.0.1:1/login", "POST");
            let del = make_test_case(
                "del",
                "Delete User",
                "http://127.0.0.1:1/accounts/{{new_account_id}}",
                "DELETE",
            );
            let repo = MockTestCaseRepository::new()
                .with_test_case(signup)
                .with_test_case(login)
                .with_test_case(del);

            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("a", "testCase", serde_json::json!({
                    "testCaseId": "signup",
                    "config": {"outputVars": [{"name": "new_account_id", "path": "$.accountId"}]}
                })),
                // Teardown, in the order the edges give: login first, then delete.
                make_node("t1", "testCase", serde_json::json!({
                    "testCaseId": "login", "config": {"teardown": true}
                })),
                make_node("t2", "testCase", serde_json::json!({
                    "testCaseId": "del", "config": {"teardown": true}
                })),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "a", None),
                make_edge("e2", "a", "t1", Some("success")),
                make_edge("e3", "t1", "t2", Some("success")),
                make_edge("e4", "t2", "end", Some("success")),
            ]);

            engine
                .execute_flow("exec1", &flow, &repo, environment, HashMap::new(), None)
                .await
                .unwrap()
                .results
        }

        // Signup fails (connection refused → error, which used to stop the flow
        // dead). Teardown still runs, in edge order, and is labelled as teardown.
        let results = run("http://127.0.0.1:1/signup", HashMap::new()).await;
        let names: Vec<&str> = results
            .iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(names, vec!["Signup", "Admin login", "Delete User"], "{:?}", names);
        assert_eq!(results[1].teardown, Some(true));
        assert_eq!(results[2].teardown, Some(true));

        // Guard 1: new_account_id was never produced, so the DELETE is not sent.
        let del = &results[2];
        assert_eq!(del.status, NodeStatus::Skipped);
        assert!(del.request.is_none(), "nothing may be sent");
        assert!(
            del.error_message.as_deref().unwrap_or("").contains("never produced by this run"),
            "{:?}",
            del.error_message
        );

        // Guard 2: the dangerous one. A leftover new_account_id in the environment
        // resolves cleanly and names a real account this run never created.
        let mut env = HashMap::new();
        env.insert(
            "new_account_id".to_string(),
            serde_json::json!("acct-from-a-previous-run"),
        );
        let results = run("http://127.0.0.1:1/signup", env).await;
        let del = &results[2];
        assert_eq!(del.status, NodeStatus::Skipped);
        assert!(del.request.is_none(), "a stale id must never be deleted");
        assert!(
            del.error_message.as_deref().unwrap_or("").contains("environment/globals"),
            "{:?}",
            del.error_message
        );
    }

    /// Marked nodes leave the normal path: otherwise they would also run inline,
    /// on the happy path only, which is the opposite of always.
    #[tokio::test]
    async fn a_teardown_node_runs_once_not_twice() {
        let engine = ExecutionEngine::new(false, None);
        let a = make_test_case("a", "Step", "http://127.0.0.1:1/a", "POST");
        let t = make_test_case("t", "Cleanup", "http://127.0.0.1:1/t", "DELETE");
        let repo = MockTestCaseRepository::new().with_test_case(a).with_test_case(t);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "t", Some("success")),
            make_edge("e3", "t", "end", Some("success")),
        ]);

        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;
        assert_eq!(
            results.iter().filter(|r| r.test_case_name.as_deref() == Some("Cleanup")).count(),
            1
        );
    }

    /// Debug mode has to answer "why did it send *that*?" — a value pulled from the
    /// environment when this run was supposed to produce it looks entirely normal.
    #[tokio::test]
    async fn debug_mode_says_where_each_value_came_from() {
        async fn logs_for(debug: bool) -> String {
            let engine = ExecutionEngine::new(debug, None);
            let tc = make_test_case(
                "bal",
                "Balance Enquiry",
                "http://127.0.0.1:1/wallet/{{my_user_id}}/balance",
                "GET",
            );
            let repo = MockTestCaseRepository::new().with_test_case(tc);
            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("n1", "testCase", serde_json::json!({"testCaseId": "bal"})),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "n1", None),
                make_edge("e2", "n1", "end", Some("success")),
            ]);
            let mut env = HashMap::new();
            env.insert("my_user_id".to_string(), serde_json::json!("stale-from-a-previous-run"));
            engine
                .execute_flow("exec1", &flow, &repo, env, HashMap::new(), None)
                .await
                .unwrap()
                .results[0]
                .logs
                .join("\n")
        }

        let debug = logs_for(true).await;
        assert!(
            debug.contains("my_user_id ← environment/globals = stale-from-a-previous-run"),
            "{}",
            debug
        );

        // Quiet by default — this is a diagnostic, not a running commentary.
        let plain = logs_for(false).await;
        assert!(!plain.contains("←"), "{}", plain);
    }

    /// A leftover my_user_id = "null" in Globals sent GET /wallet/null/balance and
    /// nothing said so: it resolved, so the unresolved-variable warning was silent.
    #[tokio::test]
    async fn a_leftover_null_in_the_environment_is_called_out() {
        let engine = ExecutionEngine::new(true, None);
        let tc = make_test_case(
            "bal",
            "Balance Enquiry",
            "http://127.0.0.1:1/wallet/{{my_user_id}}/balance",
            "GET",
        );
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("n1", "testCase", serde_json::json!({"testCaseId": "bal"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "n1", None),
            make_edge("e2", "n1", "end", Some("success")),
        ]);

        let mut env = HashMap::new();
        env.insert("my_user_id".to_string(), serde_json::json!("null"));
        let result = engine
            .execute_flow("exec1", &flow, &repo, env, HashMap::new(), None)
            .await
            .unwrap();

        let logs = result.results[0].logs.join("\n");
        assert!(logs.contains("resolved to the text"), "{}", logs);
        assert!(logs.contains("my_user_id"), "{}", logs);
        // It really did go out as the four letters, which is the point.
        let url = &result.results[0].request.as_ref().unwrap().url;
        assert!(url.ends_with("/wallet/null/balance"), "{}", url);
    }

    /// "Send SMS" is a 202 in one flow and a 402 in the flow with no balance. The
    /// node says which, and the test case's own assertion — written for the happy
    /// path — must not get a vote on that node.
    #[tokio::test]
    async fn a_nodes_expect_decides_and_the_shared_script_stays_out_of_it() {
        async fn run(node_config: serde_json::Value) -> NodeResult {
            let url = stub_once(402, r#"{"code":"LOW_BALANCE"}"#).await;
            let engine = ExecutionEngine::new(true, None);
            let mut tc = make_test_case("sms", "Send SMS", &url, "POST");
            // The happy-path assertion: would fail this 402, and captures as it goes.
            tc.assertion_script =
                Some("SAT.vars.txn = \"captured\"; response.status == 202".to_string());
            let repo = MockTestCaseRepository::new().with_test_case(tc);

            let mut data = serde_json::json!({"testCaseId": "sms"});
            data.as_object_mut().unwrap().insert("config".into(), node_config);
            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("n1", "testCase", data),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "n1", None),
                make_edge("e2", "n1", "end", Some("success")),
            ]);
            engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap()
                .results
                .remove(0)
        }

        // The node says 402, so the 402 passes even though the test case wanted 202.
        let shorthand = run(serde_json::json!({"check": "402"})).await;
        assert_eq!(shorthand.status, NodeStatus::Passed, "{:?}", shorthand.error_message);

        // An expression can look at the body, and may capture for itself.
        let expr = run(serde_json::json!({
            "check": "SAT.vars.reason = response.json.code; response.status == 402"
        })).await;
        assert_eq!(expr.status, NodeStatus::Passed, "{:?}", expr.error_message);

        // A blank Expect hands the verdict back to the test case, which wants 202.
        let blank = run(serde_json::json!({"check": "   "})).await;
        assert_eq!(blank.status, NodeStatus::Failed);
        assert!(
            blank.error_message.as_deref().unwrap_or("").contains("Assertion returned false"),
            "{:?}",
            blank.error_message
        );

        // No Expect at all behaves exactly as it did before this existed.
        let none = run(serde_json::json!({})).await;
        assert_eq!(none.status, NodeStatus::Failed);

        // A node's wrong Expect names the node, so you know which layer decided.
        let wrong = run(serde_json::json!({"check": "202"})).await;
        assert_eq!(wrong.status, NodeStatus::Failed);
        assert_eq!(
            wrong.error_message.as_deref(),
            Some("Expected HTTP 202, got 402")
        );
    }

    /// The status shorthand and a full expression are read the same way for a node
    /// as for a dataset row — one parser, so they can't drift apart.
    #[test]
    fn a_check_is_a_status_a_expression_or_nothing() {
        assert!(matches!(parse_check(Some("402")), Check::Status(402)));
        assert!(matches!(parse_check(Some("  402  ")), Check::Status(402)));
        assert!(matches!(parse_check(Some("response.status == 402")), Check::Expr(_)));
        // Not a u16, so it can only be an expression.
        assert!(matches!(parse_check(Some("99999")), Check::Expr(_)));
        assert!(matches!(parse_check(Some("   ")), Check::Unstated));
        assert!(matches!(parse_check(None), Check::Unstated));
    }

    /// Two nodes can point at one test case in different roles. Without the node's
    /// own name, both results read "Login" and you can't tell which one failed.
    #[tokio::test]
    async fn a_named_node_carries_its_name_into_the_result() {
        // One node per flow: an errored node halts the run, so two aliases need two.
        async fn label_for(alias: serde_json::Value) -> Option<String> {
            let engine = ExecutionEngine::new(true, None);
            let repo = MockTestCaseRepository::new();
            let mut data = serde_json::json!({"testCaseId": "missing"});
            data["alias"] = alias;
            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("n1", "testCase", data),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "n1", None),
                make_edge("e2", "n1", "end", Some("success")),
            ]);
            let result = engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap();
            result.results.first().expect("the node ran").node_label.clone()
        }

        assert_eq!(
            label_for(serde_json::json!("Login as new user")).await.as_deref(),
            Some("Login as new user")
        );
        // Blank is not a name: it must not blank out the test case name downstream.
        assert_eq!(label_for(serde_json::json!("   ")).await, None);
        assert_eq!(label_for(serde_json::Value::Null).await, None);
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

    /// A one-character typo in a JSONPath ($.accesss_token) matched nothing, was
    /// skipped in silence, and surfaced much later as a literal {{my_jwt}} in a
    /// different request. The export itself has to say so, and name the real keys.
    #[test]
    fn an_export_path_that_matches_nothing_says_so() {
        let engine = ExecutionEngine::new(false, None); // not debug: must warn anyway
        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();
        let tc = make_test_case("tc1", "Login", "http://x/", "POST");
        let body = serde_json::json!({"access_token": "ey.J", "refresh_token": "ey.R"});

        let exported = engine.process_exports(
            &tc,
            &[ExportVariable { name: "my_jwt".into(), json_path: "$.accesss_token".into() }],
            &Some(body),
            &mut ctx,
            &mut logs,
        );

        assert!(exported.is_none() || exported.unwrap().is_empty());
        let log = logs.join("\n");
        assert!(log.contains("nothing at $.accesss_token"), "{}", log);
        assert!(log.contains("access_token, refresh_token"), "{}", log);
        assert!(log.contains("{{my_jwt}} will not resolve"), "{}", log);
        // And the correct spelling stays quiet and works.
        let mut logs2 = Vec::new();
        let ok = engine.process_exports(
            &tc,
            &[ExportVariable { name: "my_jwt".into(), json_path: "$.access_token".into() }],
            &Some(serde_json::json!({"access_token": "ey.J"})),
            &mut ctx,
            &mut logs2,
        );
        assert_eq!(ok.unwrap().get("my_jwt").and_then(|v| v.as_str()), Some("ey.J"));
        assert!(logs2.is_empty(), "{:?}", logs2);
    }

    #[test]
    fn top_level_keys_names_what_the_body_offered() {
        let body = serde_json::json!({"access_token": "a", "refresh_token": "b"});
        assert_eq!(top_level_keys(&body), " (body has: access_token, refresh_token)");
        // A wide body is summarised rather than dumped into the log.
        let wide: serde_json::Map<String, serde_json::Value> =
            (0..12).map(|i| (format!("k{:02}", i), serde_json::json!(i))).collect();
        let listed = top_level_keys(&serde_json::Value::Object(wide));
        assert!(listed.contains("\u{2026} 4 more"), "{}", listed);
        // Nothing useful to say about a non-object.
        assert_eq!(top_level_keys(&serde_json::json!([1, 2])), "");
        assert_eq!(top_level_keys(&serde_json::json!({})), "");
    }

    /// A "Login as PA" node exported my_jwt with no JSON path. The row was dropped
    /// in silence and a later node sent "Bearer {{my_jwt}}" literally, so the only
    /// evidence was a 500 from the server. Both halves must now say something.
    #[tokio::test]
    async fn a_half_filled_export_and_an_unresolved_variable_both_warn() {
        let engine = ExecutionEngine::new(true, None);
        let tc = TestCase {
            id: "login".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Login".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "DELETE".to_string(),
            // Nothing sets my_jwt, exactly as in the reported flow.
            endpoint: "http://127.0.0.1:1/accounts/1".to_string(),
            headers: serde_json::json!({"Authorization": "Bearer {{my_jwt}}"}),
            payload: None,
            exports: vec![],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("n1", "testCase", serde_json::json!({
                "testCaseId": "login",
                "config": {"outputVars": [
                    {"name": "my_jwt", "path": ""},      // named, no path
                    {"name": "", "path": "$.token"},     // path, no name
                    {"name": "", "path": ""},            // untouched row: no noise
                ]}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "n1", None),
            make_edge("e2", "n1", "end", Some("success")),
        ]);

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();
        let logs = result.results[0].logs.join("\n");

        assert!(logs.contains("my_jwt") && logs.contains("no JSON path"), "{}", logs);
        assert!(logs.contains("$.token") && logs.contains("has no name"), "{}", logs);
        // The literal that actually reached the server is now called out.
        assert!(logs.contains("Unresolved variable(s) sent literally"), "{}", logs);
        assert!(logs.contains("my_jwt"), "{}", logs);
        // Exactly two export complaints — the blank row is not one of them.
        assert_eq!(logs.matches("Output variable").count(), 2, "{}", logs);
    }

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
