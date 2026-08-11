//! Graph validator for flow validation
//!
//! Validates flow graphs for structural correctness:
//! - Exactly one START node
//! - At least one END node
//! - No orphaned or unreachable nodes
//! - Valid edge references
//! - Valid test case and flow references
//! - No circular dependencies in group nodes

use std::collections::{HashMap, HashSet};
use serde::Serialize;

use crate::db::models::{Flow, GraphData, GraphNode, GraphEdge, TestCase};
use crate::db::repositories::{FlowRepository, TestCaseRepository};
use crate::error::AppError;

/// Validation result containing errors and warnings
#[derive(Debug, Clone, Serialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<ValidationIssue>,
    pub warnings: Vec<ValidationIssue>,
}

/// A single validation issue (error or warning)
#[derive(Debug, Clone, Serialize)]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
}

impl ValidationIssue {
    fn error(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            severity: "error".to_string(),
            node_id: None,
            edge_id: None,
        }
    }

    fn error_with_node(code: &str, message: impl Into<String>, node_id: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            severity: "error".to_string(),
            node_id: Some(node_id.to_string()),
            edge_id: None,
        }
    }

    fn error_with_edge(code: &str, message: impl Into<String>, edge_id: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            severity: "error".to_string(),
            node_id: None,
            edge_id: Some(edge_id.to_string()),
        }
    }

    fn warning(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            severity: "warning".to_string(),
            node_id: None,
            edge_id: None,
        }
    }

    fn warning_with_node(code: &str, message: impl Into<String>, node_id: &str) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            severity: "warning".to_string(),
            node_id: Some(node_id.to_string()),
            edge_id: None,
        }
    }
}

/// Graph validator that uses repositories for reference checks
pub struct GraphValidator<'a> {
    tc_repo: &'a dyn TestCaseRepository,
    flow_repo: &'a dyn FlowRepository,
}

impl<'a> GraphValidator<'a> {
    pub fn new(tc_repo: &'a dyn TestCaseRepository, flow_repo: &'a dyn FlowRepository) -> Self {
        Self { tc_repo, flow_repo }
    }

    /// Validate a flow's graph structure
    pub async fn validate(&self, flow: &Flow) -> Result<ValidationResult, AppError> {
        let mut errors = Vec::new();
        let mut warnings = Vec::new();

        let graph = &flow.graph_data;

        // === STRUCTURAL CHECKS (no DB needed) ===

        // 1. Check START node
        let start_nodes: Vec<&GraphNode> = graph.nodes.iter()
            .filter(|n| n.node_type == "start")
            .collect();

        match start_nodes.len() {
            0 => errors.push(ValidationIssue::error(
                "NO_START_NODE",
                "Flow must have exactly one START node"
            )),
            1 => {},
            _ => errors.push(ValidationIssue::error(
                "MULTIPLE_START_NODES",
                format!("Flow has {} START nodes, expected exactly 1", start_nodes.len())
            )),
        }

        // 2. Check END node
        let end_nodes: Vec<&GraphNode> = graph.nodes.iter()
            .filter(|n| n.node_type == "end")
            .collect();

        if end_nodes.is_empty() {
            errors.push(ValidationIssue::error(
                "NO_END_NODE",
                "Flow must have at least one END node"
            ));
        }

        // 3. Check orphaned nodes (no edges at all)
        for node in &graph.nodes {
            let has_incoming = graph.edges.iter().any(|e| e.target == node.id);
            let has_outgoing = graph.edges.iter().any(|e| e.source == node.id);

            // START nodes don't need incoming edges
            // END nodes don't need outgoing edges
            let is_orphaned = match node.node_type.as_str() {
                "start" => !has_outgoing,
                "end" => !has_incoming,
                _ => !has_incoming && !has_outgoing,
            };

            if is_orphaned {
                errors.push(ValidationIssue::error_with_node(
                    "ORPHANED_NODE",
                    format!("Node '{}' ({}) is not connected to the flow", node.id, node.node_type),
                    &node.id
                ));
            }
        }

        // 4. Check reachability from START
        if let Some(start) = start_nodes.first() {
            let reachable = find_reachable_nodes(graph, &start.id);
            for node in &graph.nodes {
                if node.node_type != "start" && !reachable.contains(&node.id) {
                    errors.push(ValidationIssue::error_with_node(
                        "UNREACHABLE_NODE",
                        format!("Node '{}' cannot be reached from START", node.id),
                        &node.id
                    ));
                }
            }
        }

        // 5. Check edge references (within graph)
        let node_ids: HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
        for edge in &graph.edges {
            if !node_ids.contains(edge.source.as_str()) {
                errors.push(ValidationIssue::error_with_edge(
                    "INVALID_EDGE_SOURCE",
                    format!("Edge source '{}' does not exist", edge.source),
                    &edge.id
                ));
            }
            if !node_ids.contains(edge.target.as_str()) {
                errors.push(ValidationIssue::error_with_edge(
                    "INVALID_EDGE_TARGET",
                    format!("Edge target '{}' does not exist", edge.target),
                    &edge.id
                ));
            }
        }

        // === REFERENCE CHECKS (targeted DB queries) ===

        // 6. Check test case references
        let referenced_tc_ids: Vec<String> = graph.nodes.iter()
            .filter(|n| n.node_type == "testCase")
            .filter_map(|n| extract_test_case_id(&n.data))
            .collect();

        if !referenced_tc_ids.is_empty() {
            let existing_tc_ids = self.tc_repo.find_existing_ids(&referenced_tc_ids).await?;

            for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
                if let Some(tc_id) = extract_test_case_id(&node.data) {
                    if !existing_tc_ids.contains(&tc_id) {
                        errors.push(ValidationIssue::error_with_node(
                            "MISSING_TEST_CASE",
                            format!("Test case '{}' not found", tc_id),
                            &node.id
                        ));
                    }
                }
            }
        }

        // 6b. Nodes set to run once per data row. The dataset lives on the test case, so
        // this needs the test case itself rather than just its id.
        for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
            let marked = node
                .data
                .get("config")
                .and_then(|c| c.get("forEachRow"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !marked {
                continue;
            }
            let test_case = match extract_test_case_id(&node.data) {
                Some(id) => self.tc_repo.get_by_id(&id).await?,
                None => None,
            };
            warnings.extend(fan_out_warnings(node, test_case.as_ref()));
        }

        // 6c. Nodes that may have to ask more than once. No test case needed: polling is
        // a property of this step in this flow, not of the request.
        for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
            warnings.extend(poll_warnings(node));
        }

        // 6d. Nodes that walk a list. Also no test case needed — which list to walk is a
        // property of the step, and whether the list exists is only knowable at run time.
        // Filed by the severity each issue declares, rather than by which list the call
        // site happens to name. `valid` is derived from `errors`, so an error-severity
        // issue pushed into `warnings` would read "error" in the panel and still not
        // block — two answers about one flow. Splitting here means a warning added to
        // `for_each_issues` later cannot land in the wrong one.
        for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
            for issue in for_each_issues(node) {
                if issue.severity == "error" {
                    errors.push(issue);
                } else {
                    warnings.push(issue);
                }
            }
        }

        // 6e. Steps that wait for a callback. An error, not a warning: a wait with no path
        // cannot run at all, and the run-time report would come sixty seconds into a flow
        // rather than before it started.
        for node in graph.nodes.iter().filter(|n| n.node_type == "awaitCallback") {
            errors.extend(await_errors(node));
        }

        // 7. Check group node flow references
        let referenced_flow_ids: Vec<String> = graph.nodes.iter()
            .filter(|n| n.node_type == "group")
            .filter_map(|n| extract_flow_id(&n.data))
            .collect();

        if !referenced_flow_ids.is_empty() {
            let existing_flow_ids = self.flow_repo.find_existing_ids(&referenced_flow_ids).await?;

            for node in graph.nodes.iter().filter(|n| n.node_type == "group") {
                if let Some(ref_flow_id) = extract_flow_id(&node.data) {
                    // Self-reference check
                    if ref_flow_id == flow.id {
                        errors.push(ValidationIssue::error_with_node(
                            "SELF_REFERENCE",
                            "Group node references its own flow",
                            &node.id
                        ));
                    }
                    // Existence check
                    else if !existing_flow_ids.contains(&ref_flow_id) {
                        errors.push(ValidationIssue::error_with_node(
                            "MISSING_FLOW_REF",
                            format!("Flow '{}' not found", ref_flow_id),
                            &node.id
                        ));
                    }
                    // Circular dependency check
                    else if self.has_circular_dependency(&flow.id, &ref_flow_id).await? {
                        errors.push(ValidationIssue::error_with_node(
                            "CIRCULAR_DEPENDENCY",
                            "Would create circular dependency",
                            &node.id
                        ));
                    }
                }
            }
        }

        // === WARNINGS ===

        // Missing failure edges on test case nodes
        for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
            let has_failure = graph.edges.iter()
                .any(|e| e.source == node.id && edge_type_is(&e, "failure"));

            if !has_failure {
                warnings.push(ValidationIssue::warning_with_node(
                    "NO_FAILURE_EDGE",
                    "No failure edge - execution stops if test fails",
                    &node.id
                ));
            }
        }

        // Missing success edges on test case nodes
        for node in graph.nodes.iter().filter(|n| n.node_type == "testCase") {
            let has_success = graph.edges.iter()
                .any(|e| e.source == node.id &&
                     (edge_type_is(&e, "success") || edge_type_is(&e, "default") || e.edge_type.is_none()));

            if !has_success {
                warnings.push(ValidationIssue::warning_with_node(
                    "NO_SUCCESS_EDGE",
                    "No success edge - dead end on success",
                    &node.id
                ));
            }
        }

        // Empty flow check
        let has_test_nodes = graph.nodes.iter().any(|n| {
            n.node_type == "testCase" || n.node_type == "group" || n.node_type == "awaitCallback"
        });

        if !has_test_nodes {
            warnings.push(ValidationIssue::warning(
                "EMPTY_FLOW",
                "Flow has no test cases - nothing to execute"
            ));
        }

        Ok(ValidationResult {
            valid: errors.is_empty(),
            errors,
            warnings,
        })
    }

    /// Check for circular dependency using DFS
    async fn has_circular_dependency(
        &self,
        original_flow_id: &str,
        checking_flow_id: &str,
    ) -> Result<bool, AppError> {
        let mut visited = HashSet::new();
        self.check_circular_recursive(original_flow_id, checking_flow_id, &mut visited).await
    }

    async fn check_circular_recursive(
        &self,
        original_flow_id: &str,
        checking_flow_id: &str,
        visited: &mut HashSet<String>,
    ) -> Result<bool, AppError> {
        if checking_flow_id == original_flow_id {
            return Ok(true);
        }
        if visited.contains(checking_flow_id) {
            return Ok(false);
        }
        visited.insert(checking_flow_id.to_string());

        // Fetch only this flow's graph
        if let Some(flow) = self.flow_repo.get_by_id(checking_flow_id).await? {
            for node in flow.graph_data.nodes.iter().filter(|n| n.node_type == "group") {
                if let Some(nested_flow_id) = extract_flow_id(&node.data) {
                    if Box::pin(self.check_circular_recursive(
                        original_flow_id,
                        &nested_flow_id,
                        visited
                    )).await? {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }

}

/// Find all nodes reachable from a starting node using BFS
fn find_reachable_nodes(graph: &GraphData, start_id: &str) -> HashSet<String> {
    let mut reachable = HashSet::new();
    let mut queue = vec![start_id.to_string()];

    // Build adjacency list
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &graph.edges {
        adjacency.entry(edge.source.as_str())
            .or_default()
            .push(edge.target.as_str());
    }

    while let Some(node_id) = queue.pop() {
        if reachable.contains(&node_id) {
            continue;
        }
        reachable.insert(node_id.clone());

        if let Some(neighbors) = adjacency.get(node_id.as_str()) {
            for &neighbor in neighbors {
                if !reachable.contains(neighbor) {
                    queue.push(neighbor.to_string());
                }
            }
        }
    }

    reachable
}

/// Extract test_case_id from node data JSON
fn extract_test_case_id(data: &serde_json::Value) -> Option<String> {
    data.get("testCaseId")
        .or_else(|| data.get("test_case_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Extract flow_id from node data JSON
fn extract_flow_id(data: &serde_json::Value) -> Option<String> {
    data.get("flowId")
        .or_else(|| data.get("flow_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Check if edge has a specific type
fn edge_type_is(edge: &GraphEdge, expected: &str) -> bool {
    edge.edge_type.as_ref().map(|t| t == expected).unwrap_or(false)
}

/// Problems with a node that polls.
///
/// Both of these fail quietly, which is why they are worth saying before a run: one turns
/// the polling off without removing it from the panel, the other leaves it on but gives it
/// no room to work.
fn poll_warnings(node: &GraphNode) -> Vec<ValidationIssue> {
    let Some(poll) = node.data.get("config").and_then(|c| c.get("poll")) else {
        return Vec::new();
    };

    // Absence of `until` is how the engine says "this node does not poll", so a panel with
    // an interval and no condition sends once and judges the 202 — the answer that says
    // only "I have your file".
    let until = poll.get("until").and_then(|v| v.as_str()).unwrap_or("").trim();
    if until.is_empty() {
        return vec![ValidationIssue::warning_with_node(
            "POLL_WITHOUT_UNTIL",
            "This step is set to poll but has no \"until\" condition, so it will send once \
             and judge the first answer — say what makes the answer settled, or turn the \
             polling off",
            &node.id,
        )];
    }

    let ms = |key: &str| poll.get(key).and_then(|v| v.as_u64()).filter(|n| *n > 0);
    let interval = ms("intervalMs").unwrap_or(crate::execution::POLL_INTERVAL_MS);
    let budget = ms("timeoutMs").unwrap_or(crate::execution::POLL_TIMEOUT_MS);
    if budget < interval {
        return vec![ValidationIssue::warning_with_node(
            "POLL_BUDGET_BELOW_INTERVAL",
            format!(
                "This step waits {}ms between attempts but gives up after {}ms, so it will \
                 ask once and report that it never settled — raise the budget above the \
                 interval",
                interval, budget
            ),
            &node.id,
        )];
    }

    Vec::new()
}

/// Problems with a node set to run once per data row — all findable before a run, and
/// What a step set to "once per item in a list" gets wrong before it is even run.
///
/// Deliberately *not* checking that the list exists: it is produced by an earlier step at
/// run time, so the only honest answer here is silence. The panel checks that against the
/// upstream collections it can see, live, where the author can fix it.
fn for_each_issues(node: &GraphNode) -> Vec<ValidationIssue> {
    let config = node.data.get("config");
    let Some(spec) = config.and_then(|c| c.get("forEach")) else {
        return Vec::new();
    };

    let mut issues = Vec::new();
    let list = spec
        .get("list")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_start_matches("{{").trim_end_matches("}}").trim())
        .filter(|s| !s.is_empty());

    if list.is_none() {
        issues.push(ValidationIssue::error_with_node(
            "FOREACH_WITHOUT_LIST",
            "This step is set to run once per item, but no list is named — it cannot run. Open the node and pick the list to walk".to_string(),
            &node.id,
        ));
    }

    // Unreachable from the panel's three-way toggle, and reachable through the API or a
    // hand-edited graph. An error rather than a warning: there is no sensible way to guess
    // which the author meant, and guessing is how a step quietly tests the wrong thing.
    let per_row = config
        .and_then(|c| c.get("forEachRow"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if per_row {
        issues.push(ValidationIssue::error_with_node(
            "FOREACH_AND_FANOUT",
            "This step is set to run both once per data row and once per item in a list. Pick one".to_string(),
            &node.id,
        ));
    }

    issues
}

/// A step that waits for a callback, checked before a run rather than sixty seconds into one.
fn await_errors(node: &GraphNode) -> Vec<ValidationIssue> {
    let cfg = node.data.get("config").and_then(|c| c.get("awaitCallback"));
    let path = cfg
        .and_then(|c| c.get("path"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if path.is_empty() {
        return vec![ValidationIssue::error_with_node(
            "AWAIT_WITHOUT_PATH",
            "This step waits for a callback but no path is set — give it the path your test \
             puts in its callback URL"
                .to_string(),
            &node.id,
        )];
    }
    Vec::new()
}

/// all otherwise discovered from a puzzling result. `test_case` is None when the
/// reference is broken, which MISSING_TEST_CASE already reports.
fn fan_out_warnings(node: &GraphNode, test_case: Option<&TestCase>) -> Vec<ValidationIssue> {
    let config = node.data.get("config");
    let marked = config
        .and_then(|c| c.get("forEachRow"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !marked {
        return Vec::new();
    }

    let mut issues = Vec::new();

    // A step that runs more than once gathers one record per run, under a name the author
    // gives it. Without the name there is nowhere to put the records, and the old symptom
    // returns: {{name}} arriving literally at some later node.
    let declared: Vec<&str> = config
        .and_then(|c| c.get("outputVars"))
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|r| r.get("name").and_then(|v| v.as_str()))
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let into = config
        .and_then(|c| c.get("collect"))
        .and_then(|c| c.get("into"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match (into, declared.is_empty()) {
        (None, false) => issues.push(ValidationIssue::warning_with_node(
            "FANOUT_COLLECTION_UNNAMED",
            format!(
                "This step runs once per data row, so its output variable(s) {} need a list to be collected into — set \"Collect into\". As it stands nothing is carried forward",
                declared.join(", ")
            ),
            &node.id,
        )),
        (Some(into), true) => issues.push(ValidationIssue::warning_with_node(
            "FANOUT_COLLECTION_EMPTY",
            format!(
                "\"{}\" has no fields to collect — add output variable(s) naming what to take from each response",
                into
            ),
            &node.id,
        )),
        _ => {}
    }

    let Some(test_case) = test_case else {
        return issues;
    };
    let rows = test_case.dataset.as_ref().map(|d| d.rows.as_slice()).unwrap_or(&[]);

    if rows.is_empty() {
        issues.push(ValidationIssue::warning_with_node(
            "FANOUT_NO_ROWS",
            format!(
                "This step is set to run once per data row, but '{}' has no data rows — it                  will run once, as authored",
                test_case.name
            ),
            &node.id,
        ));
        return issues;
    }

    // An absent list means every row; an empty one means none.
    if let Some(chosen) = config.and_then(|c| c.get("rowIds")).and_then(|v| v.as_array()) {
        if chosen.is_empty() {
            issues.push(ValidationIssue::warning_with_node(
                "FANOUT_NO_ROWS_SELECTED",
                "No data rows are selected for this step, so it will fail without sending                  anything",
                &node.id,
            ));
            return issues;
        }
        let missing: Vec<&str> = chosen
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|id| !rows.iter().any(|row| row.id == *id))
            .collect();
        if !missing.is_empty() {
            issues.push(ValidationIssue::warning_with_node(
                "FANOUT_STALE_ROWS",
                format!(
                    "{} data row(s) selected for this step are no longer in '{}' ({}) —                      nothing will run for them",
                    missing.len(),
                    test_case.name,
                    missing.join(", ")
                ),
                &node.id,
            ));
        }
    }

    // Every row this step would run is parked. It sends nothing and reports a skip, which
    // is honest but silent — worth saying on the canvas, because a step that tests
    // nothing looks exactly like one that does.
    let would_run: Vec<_> = match config.and_then(|c| c.get("rowIds")).and_then(|v| v.as_array()) {
        Some(chosen) => {
            let ids: Vec<&str> = chosen.iter().filter_map(|v| v.as_str()).collect();
            rows.iter().filter(|row| ids.contains(&row.id.as_str())).collect()
        }
        None => rows.iter().collect(),
    };
    if !would_run.is_empty() && would_run.iter().all(|row| row.disabled) {
        issues.push(ValidationIssue::warning_with_node(
            "FANOUT_ALL_ROWS_DISABLED",
            format!(
                "Every data row this step would run is disabled, so it will send nothing — enable a row in '{}' or turn off \"once per row\"",
                test_case.name
            ),
            &node.id,
        ));
    }

    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fan_out_node(config: serde_json::Value) -> GraphNode {
        GraphNode {
            id: "n1".to_string(),
            node_type: "testCase".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({"testCaseId": "tc1", "config": config}),
            width: None,
            height: None,
        }
    }

    fn test_case_with(rows: Vec<&str>) -> TestCase {
        use crate::db::models::{DataRow, Dataset};
        TestCase {
            id: "tc1".to_string(),
            project_id: "p1".to_string(),
            group_id: None,
            name: "Send SMS".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "POST".to_string(),
            endpoint: "http://x/".to_string(),
            headers: serde_json::json!({}),
            payload: None,
            body_type: None,
            exports: vec![],
            assertion_script: None,
            pre_test_script: None,
            dataset: (!rows.is_empty()).then(|| Dataset {
                rows: rows
                    .into_iter()
                    .map(|id| DataRow { id: id.to_string(), ..Default::default() })
                    .collect(),
            }),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn codes(issues: Vec<ValidationIssue>) -> Vec<String> {
        issues.into_iter().map(|i| i.code).collect()
    }

    #[test]
    fn a_node_not_set_to_run_per_row_is_never_warned_about() {
        let tc = test_case_with(vec!["r0"]);
        assert!(fan_out_warnings(&fan_out_node(serde_json::json!({})), Some(&tc)).is_empty());
        assert!(fan_out_warnings(
            &fan_out_node(serde_json::json!({"forEachRow": false, "rowIds": ["ghost"]})),
            Some(&tc)
        )
        .is_empty());
    }

    #[test]
    fn running_every_row_is_not_a_warning() {
        let tc = test_case_with(vec!["r0", "r1"]);
        let node = fan_out_node(serde_json::json!({"forEachRow": true}));
        assert!(fan_out_warnings(&node, Some(&tc)).is_empty());
    }

    #[test]
    fn a_per_row_node_on_a_request_without_rows_is_flagged_before_the_run() {
        let tc = test_case_with(vec![]);
        let node = fan_out_node(serde_json::json!({"forEachRow": true}));
        assert_eq!(codes(fan_out_warnings(&node, Some(&tc))), vec!["FANOUT_NO_ROWS"]);
    }

    #[test]
    fn output_variables_with_nowhere_to_be_collected_are_flagged() {
        let tc = test_case_with(vec!["r0"]);
        let node = fan_out_node(serde_json::json!({
            "forEachRow": true,
            "outputVars": [{"name": "token", "path": "$.token"}, {"name": "  ", "path": "$.x"}]
        }));
        let issues = fan_out_warnings(&node, Some(&tc));
        assert_eq!(codes(issues.clone()), vec!["FANOUT_COLLECTION_UNNAMED"]);
        // Names the variable, and ignores the half-filled row.
        assert!(issues[0].message.contains("token"), "{}", issues[0].message);
        assert!(issues[0].message.contains("Collect into"), "{}", issues[0].message);
    }

    #[test]
    fn walking_a_list_with_no_list_named_is_an_error() {
        // An error, not a warning: the step cannot run at all, so letting the flow read as
        // valid would mean discovering it only from a failed run.
        let node = fan_out_node(serde_json::json!({"forEach": {"as": "campaignId"}}));
        let issues = for_each_issues(&node);
        assert_eq!(codes(issues.clone()), vec!["FOREACH_WITHOUT_LIST"]);
        assert_eq!(issues[0].severity, "error");
    }

    #[test]
    fn walking_a_list_is_not_flagged_when_a_list_is_named() {
        // Braces forgiven here too, or the panel would show an error for what the engine
        // accepts — two answers about one config.
        for list in ["launched", "{{launched}}", "  launched  "] {
            let node = fan_out_node(serde_json::json!({"forEach": {"list": list}}));
            assert!(for_each_issues(&node).is_empty(), "flagged for {list:?}");
        }
    }

    #[test]
    fn a_step_set_to_both_kinds_of_fan_out_is_an_error() {
        let node = fan_out_node(serde_json::json!({
            "forEach": {"list": "launched"},
            "forEachRow": true,
        }));
        assert_eq!(codes(for_each_issues(&node)), vec!["FOREACH_AND_FANOUT"]);
    }

    #[test]
    fn a_named_collection_with_fields_is_not_flagged() {
        // The configuration this feature exists to make work must be silent.
        let tc = test_case_with(vec!["r0"]);
        let node = fan_out_node(serde_json::json!({
            "forEachRow": true,
            "collect": {"into": "launched"},
            "outputVars": [{"name": "campaignId", "path": "$.data.campaignId"}]
        }));
        assert!(codes(fan_out_warnings(&node, Some(&tc))).is_empty());
    }

    #[test]
    fn a_collection_named_with_nothing_to_gather_is_flagged() {
        let tc = test_case_with(vec!["r0"]);
        let node = fan_out_node(serde_json::json!({
            "forEachRow": true,
            "collect": {"into": "launched"},
        }));
        let issues = fan_out_warnings(&node, Some(&tc));
        assert_eq!(codes(issues.clone()), vec!["FANOUT_COLLECTION_EMPTY"]);
        assert!(issues[0].message.contains("launched"), "{}", issues[0].message);
    }

    #[test]
    fn a_node_that_polls_without_a_condition_is_flagged() {
        // The failure this catches: the author fills in an interval, leaves `until` blank,
        // and the step sends once and passes on the 202 that says only "I have your file".
        let blank = fan_out_node(serde_json::json!({"poll": {"intervalMs": 5000}}));
        assert_eq!(codes(poll_warnings(&blank)), vec!["POLL_WITHOUT_UNTIL"]);

        let whitespace = fan_out_node(serde_json::json!({"poll": {"until": "  "}}));
        assert_eq!(codes(poll_warnings(&whitespace)), vec!["POLL_WITHOUT_UNTIL"]);

        // A condition is all that is required — the interval and budget have defaults.
        let stated = fan_out_node(serde_json::json!({
            "poll": {"until": "response.json.status != \"pending\""}
        }));
        assert!(poll_warnings(&stated).is_empty());

        // And a node with no poll block at all is every node that existed before this.
        assert!(poll_warnings(&fan_out_node(serde_json::json!({}))).is_empty());
    }

    #[test]
    fn a_budget_shorter_than_the_interval_is_flagged() {
        // It would ask once and report that it never settled — polling in name only.
        let node = fan_out_node(serde_json::json!({
            "poll": {"until": "x", "intervalMs": 5000, "timeoutMs": 3000}
        }));
        let issues = poll_warnings(&node);
        assert_eq!(codes(issues.clone()), vec!["POLL_BUDGET_BELOW_INTERVAL"]);
        // Both numbers named, so the fix is obvious without opening the panel.
        assert!(issues[0].message.contains("5000"), "{}", issues[0].message);
        assert!(issues[0].message.contains("3000"), "{}", issues[0].message);

        // Equal is not a problem: one wait still fits.
        let equal = fan_out_node(serde_json::json!({
            "poll": {"until": "x", "intervalMs": 3000, "timeoutMs": 3000}
        }));
        assert!(poll_warnings(&equal).is_empty());

        // A blank interval or budget means the default, measured against the same
        // constants the engine uses — an interval above the default budget is a real
        // problem even though the author only typed one number.
        let defaulted = fan_out_node(serde_json::json!({
            "poll": {"until": "x", "intervalMs": crate::execution::POLL_TIMEOUT_MS + 1}
        }));
        assert_eq!(codes(poll_warnings(&defaulted)), vec!["POLL_BUDGET_BELOW_INTERVAL"]);
    }

    /// A step whose every row is parked sends nothing. That is honest at run time — it
    /// reports a skip — but silent on the canvas, where it looks like any other step.
    #[test]
    fn a_step_whose_every_row_is_parked_is_flagged() {
        let mut tc = test_case_with(vec!["r0", "r1"]);
        for row in &mut tc.dataset.as_mut().unwrap().rows {
            row.disabled = true;
        }

        let all = fan_out_node(serde_json::json!({"forEachRow": true}));
        assert_eq!(codes(fan_out_warnings(&all, Some(&tc))), vec!["FANOUT_ALL_ROWS_DISABLED"]);

        // One live row is enough — the step still tests something.
        tc.dataset.as_mut().unwrap().rows[0].disabled = false;
        assert!(fan_out_warnings(&all, Some(&tc)).is_empty());

        // And it follows the selection: picking only the parked row is the same problem.
        tc.dataset.as_mut().unwrap().rows[0].disabled = false;
        let picked = fan_out_node(serde_json::json!({"forEachRow": true, "rowIds": ["r1"]}));
        assert_eq!(codes(fan_out_warnings(&picked, Some(&tc))), vec!["FANOUT_ALL_ROWS_DISABLED"]);
    }

    #[test]
    fn an_empty_and_a_stale_selection_are_told_apart() {
        let tc = test_case_with(vec!["r0", "r1"]);

        let empty = fan_out_node(serde_json::json!({"forEachRow": true, "rowIds": []}));
        assert_eq!(codes(fan_out_warnings(&empty, Some(&tc))), vec!["FANOUT_NO_ROWS_SELECTED"]);

        let stale = fan_out_node(serde_json::json!({
            "forEachRow": true, "rowIds": ["r0", "ghost"]
        }));
        let issues = fan_out_warnings(&stale, Some(&tc));
        assert_eq!(codes(issues.clone()), vec!["FANOUT_STALE_ROWS"]);
        assert!(issues[0].message.contains("ghost"), "{}", issues[0].message);

        // A selection that all still resolves says nothing.
        let fine = fan_out_node(serde_json::json!({"forEachRow": true, "rowIds": ["r1"]}));
        assert!(fan_out_warnings(&fine, Some(&tc)).is_empty());
    }

    #[test]
    fn a_broken_test_case_reference_is_left_to_the_check_that_owns_it() {
        // MISSING_TEST_CASE already reports it; saying it twice is noise.
        let node = fan_out_node(serde_json::json!({"forEachRow": true}));
        assert!(fan_out_warnings(&node, None).is_empty());
    }

    #[test]
    fn test_find_reachable_nodes() {
        let graph = GraphData {
            nodes: vec![
                GraphNode { id: "start".to_string(), node_type: "start".to_string(), position: crate::db::models::Position { x: 0.0, y: 0.0 }, data: serde_json::json!({}), width: None, height: None },
                GraphNode { id: "tc1".to_string(), node_type: "testCase".to_string(), position: crate::db::models::Position { x: 0.0, y: 0.0 }, data: serde_json::json!({}), width: None, height: None },
                GraphNode { id: "end".to_string(), node_type: "end".to_string(), position: crate::db::models::Position { x: 0.0, y: 0.0 }, data: serde_json::json!({}), width: None, height: None },
                GraphNode { id: "orphan".to_string(), node_type: "testCase".to_string(), position: crate::db::models::Position { x: 0.0, y: 0.0 }, data: serde_json::json!({}), width: None, height: None },
            ],
            edges: vec![
                GraphEdge { id: "e1".to_string(), source: "start".to_string(), target: "tc1".to_string(), edge_type: None, data: serde_json::json!({}) },
                GraphEdge { id: "e2".to_string(), source: "tc1".to_string(), target: "end".to_string(), edge_type: Some("success".to_string()), data: serde_json::json!({}) },
            ],
            canvas_settings: serde_json::json!({}),
            variables: std::collections::HashMap::new(),
        };

        let reachable = find_reachable_nodes(&graph, "start");
        assert!(reachable.contains("start"));
        assert!(reachable.contains("tc1"));
        assert!(reachable.contains("end"));
        assert!(!reachable.contains("orphan"));
    }

    #[test]
    fn an_await_step_with_no_path_is_an_error_before_the_run() {
        // Reported here rather than sixty seconds into a flow, which is when the engine's own
        // version of this message arrives.
        let node = GraphNode {
            id: "w1".to_string(),
            node_type: "awaitCallback".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({ "config": { "awaitCallback": { "count": 1 } } }),
            width: None,
            height: None,
        };
        assert_eq!(codes(await_errors(&node)), vec!["AWAIT_WITHOUT_PATH"]);
    }

    #[test]
    fn an_await_step_with_a_path_is_fine_even_though_the_inbox_may_be_empty() {
        // Whether anything will arrive is only knowable at run time, so it is not this rule's
        // business — the same reason the list a forEach walks is not checked here.
        let node = GraphNode {
            id: "w1".to_string(),
            node_type: "awaitCallback".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({
                "config": { "awaitCallback": { "path": "dr/{{dr_path}}" } }
            }),
            width: None,
            height: None,
        };
        assert!(await_errors(&node).is_empty());
    }

}
