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
        // Cross-node, so it cannot live in `await_errors`: two waits on one inbox.
        warnings.extend(await_path_clashes(&graph.nodes));
        // Also cross-node: a step walking a list that another step promises and never fills.
        errors.extend(unfillable_lists(&graph.nodes));

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

        // 7b. What resolving the sub-flows would actually produce.
        //
        // Run through the *same* splicer the runner uses, so validation and execution cannot
        // form different opinions about what a sub-flow node means. Skipped when a group node
        // is already in error: the splice would only repeat what SELF_REFERENCE /
        // MISSING_FLOW_REF / CIRCULAR_DEPENDENCY just said, in different words, against the
        // same node.
        let group_already_wrong = errors.iter().any(|e| {
            matches!(
                e.code.as_str(),
                "SELF_REFERENCE" | "MISSING_FLOW_REF" | "CIRCULAR_DEPENDENCY"
            )
        });
        if crate::execution::has_groups(flow) && !group_already_wrong {
            let limits = crate::execution::InlineLimits::default();
            let loaded = crate::execution::load_referenced(flow, self.flow_repo, &limits).await?;
            let inlined = crate::execution::inline_groups(flow, &loaded, &limits);
            for issue in subflow_issues(flow, &loaded, &inlined) {
                if issue.severity == "error" {
                    errors.push(issue);
                } else {
                    warnings.push(issue);
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

/// A step walks a list that another step names but can never fill.
///
/// `FANOUT_COLLECTION_EMPTY` already warns on the *producer*: "Collect into" set with no output
/// variables collects nothing, because there are no fields to put in a record. On its own that is
/// only wasteful — nothing consumes the list, nothing breaks.
///
/// The moment a step in the same flow *walks* that name it stops being a warning and becomes
/// provable: the list will never exist, so the consuming step fails every run. And it fails
/// pointing at itself — "No variable named launched" — while the fix is on a different node, which
/// is a bad afternoon. A real flow hit exactly this: nineteen rows sent, a waiter set to run once
/// per record, and one amber warning on the producer lost among eight others.
///
/// Reported on **both** nodes: the consumer is where the failure appears, the producer is where the
/// fix goes, and an author looking at either should be told.
fn unfillable_lists(nodes: &[GraphNode]) -> Vec<ValidationIssue> {
    use std::collections::HashMap;

    let cfg_of = |node: &GraphNode| node.data.get("config").cloned().unwrap_or(serde_json::Value::Null);
    let name = |value: &serde_json::Value| {
        value
            .as_str()
            .map(|s| s.trim().trim_start_matches("{{").trim_end_matches("}}").trim().to_string())
            .filter(|s| !s.is_empty())
    };

    // Lists a step promises but collects nothing into.
    // What a node is called, for a message an author has to act on: two node ids in a sentence
    // are two things they then have to find on the canvas.
    let display = |node: &GraphNode| {
        node.data
            .get("alias")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                node.data.get("label").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
            })
            .unwrap_or("the step above")
            .to_string()
    };

    let mut hollow: HashMap<String, &GraphNode> = HashMap::new();
    for node in nodes {
        let cfg = cfg_of(node);
        let Some(into) = cfg.get("collect").and_then(|c| c.get("into")).and_then(name) else {
            continue;
        };
        let fields = cfg
            .get("outputVars")
            .and_then(|v| v.as_array())
            .map(|rows| {
                rows.iter().any(|row| {
                    let text = |key: &str| row.get(key).and_then(|v| v.as_str()).unwrap_or("").trim();
                    !text("name").is_empty() && !text("path").is_empty()
                })
            })
            .unwrap_or(false);
        if !fields {
            hollow.insert(into, node);
        }
    }
    if hollow.is_empty() {
        return Vec::new();
    }

    let mut issues = Vec::new();
    for node in nodes {
        let cfg = cfg_of(node);
        let Some(list) = cfg.get("forEach").and_then(|c| c.get("list")).and_then(name) else {
            continue;
        };
        let Some(producer) = hollow.get(&list) else { continue };

        // Says the *relationship*, not just the fault. "No output variables" assumes the author
        // already knows that a record is made of them — and the one who hit this asked, reasonably,
        // whether naming the list was not enough on its own.
        issues.push(ValidationIssue::error_with_node(
            "LIST_NEVER_FILLED",
            format!(
                "This step runs once per item of \"{}\", and \"{}\" will never exist. \"{}\" is \
                 only the *name* of the list — each record in it is made from the output variables \
                 of \"{}\", and that step has none, so there is nothing to put in a record. Open \
                 \"{}\" and add the field(s) you want from each response, like \
                 campaignId ← $.campaignId",
                list,
                list,
                list,
                display(producer),
                display(producer)
            ),
            &node.id,
        ));
        // And on the producer, which is where the fix goes.
        issues.push(ValidationIssue::error_with_node(
            "LIST_NEVER_FILLED",
            format!(
                "\"{}\" is named here but nothing goes into it: a record is made from this step's \
                 output variables, and there are none. \"{}\" will never exist, and \"{}\" runs \
                 once per item of it. Add the field(s) you want from each response",
                list,
                list,
                display(node)
            ),
            &producer.id,
        ));
    }
    issues
}

/// The output variable names a flow declares.
///
/// Read off the nodes, the same way the engine's own `flow_produced_names` does — a flow has no
/// declared interface, so what it exports is whatever its steps happen to export.
fn declared_outputs(flow: &Flow) -> Vec<String> {
    let mut names = Vec::new();
    for node in &flow.graph_data.nodes {
        let rows = node
            .data
            .get("config")
            .and_then(|c| c.get("outputVars"))
            .and_then(|v| v.as_array());
        for row in rows.into_iter().flatten() {
            if let Some(name) = row.get("name").and_then(|v| v.as_str()) {
                let name = name.trim();
                if !name.is_empty() && !names.iter().any(|n| n == name) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names
}

/// What a flow's sub-flow nodes will do that its author cannot see by looking at the canvas.
///
/// Every issue is attributed to a **group node**, never to an inlined step: the author has one
/// box on screen, and pointing at `g1\u{1F}signup` would name a node that exists nowhere they
/// can look.
///
/// Given the already-spliced result rather than computing its own, so a rule here and the runner
/// cannot disagree about what a sub-flow contains.
fn subflow_issues(
    flow: &Flow,
    loaded: &HashMap<String, Flow>,
    inlined: &crate::execution::Inlined,
) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    let groups = flow
        .graph_data
        .nodes
        .iter()
        .filter(|n| n.node_type == "group")
        .collect::<Vec<_>>();

    // --- Two nodes running one flow -------------------------------------------------------
    //
    // Node ids are namespaced by the splice, so both invocations genuinely run. Variable names
    // are *not*: they are string keys in one flat map, written by a plain insert. So the second
    // invocation's `new_account_id` overwrites the first's, and the first's cleanup then deletes
    // the second's account — leaking the very account this feature exists to stop leaking.
    // Keyed by the id `extract_flow_id` resolves, so the `flowId` and `flow_id` spellings of
    // one reference are counted as one flow rather than two.
    let mut by_flow: HashMap<String, Vec<&GraphNode>> = HashMap::new();
    for node in &groups {
        if let Some(id) = extract_flow_id(&node.data) {
            by_flow.entry(id).or_default().push(node);
        }
    }
    by_flow.retain(|_, nodes| nodes.len() >= 2);
    for (flow_id, sharing) in &by_flow {
        let sub = loaded.get(flow_id);
        let name = sub.map(|f| f.name.as_str()).unwrap_or(flow_id.as_str());
        let outputs = sub.map(declared_outputs).unwrap_or_default();
        for node in sharing {
            let issue = if outputs.is_empty() {
                ValidationIssue::warning_with_node(
                    "SUBFLOW_INVOKED_TWICE",
                    format!(
                        "{} steps in this flow run \"{}\". They are separate steps and both will \
                         run, but they share one set of variables.",
                        sharing.len(),
                        name
                    ),
                    &node.id,
                )
            } else {
                ValidationIssue::error_with_node(
                    "SUBFLOW_INVOKED_TWICE",
                    format!(
                        "{} steps in this flow run \"{}\", which sets {}. Variables are not \
                         scoped per step, so the second run overwrites the first's values — and \
                         cleanup would then delete the wrong thing. Use one step, or copy the \
                         flow.",
                        sharing.len(),
                        name,
                        outputs.join(", ")
                    ),
                    &node.id,
                )
            };
            issues.push(issue);
        }
    }

    // --- A failure edge out of a sub-flow node --------------------------------------------
    //
    // Dead: the node has no verdict of its own, and a failing step inside it stops the run
    // rather than continuing to the sub-flow's exit. Worse than dead, in fact — `pick_edge`'s
    // fallback can take it for a reason that has nothing to do with failure.
    for node in &groups {
        if flow
            .graph_data
            .edges
            .iter()
            .any(|e| e.source == node.id && edge_type_is(e, "failure"))
        {
            issues.push(ValidationIssue::warning_with_node(
                "GROUP_FAILURE_EDGE_IGNORED",
                "The failure edge out of this step is never taken. A step inside the sub-flow \
                 that fails stops the run there; this step has no verdict of its own to branch \
                 on.",
                &node.id,
            ));
        }
    }

    // --- Two waits on one inbox, once the sub-flows are resolved ---------------------------
    //
    // Invisible to the check on the authored graph, which sees a single group node where the
    // run sees a waiting step — or two of them, when one sub-flow is invoked twice. Run through
    // the same rule, on the flat graph, and then re-attributed to the group node.
    let origin_of: HashMap<&str, &crate::execution::NodeOrigin> = inlined
        .origins
        .iter()
        .map(|o| (o.node_id.as_str(), o))
        .collect();
    let mut clashed: Vec<(String, String)> = Vec::new();
    for issue in await_path_clashes(&inlined.flow.graph_data.nodes) {
        let Some(node_id) = issue.node_id.as_deref() else { continue };
        // A clash between two of the parent's own steps is already reported against those
        // steps by the ordinary check. Only the inlined half is news.
        let Some(origin) = origin_of.get(node_id) else { continue };
        let pair = (origin.group_node_id.clone(), origin.flow_name.clone());
        if !clashed.contains(&pair) {
            clashed.push(pair);
        }
    }
    for (group_node_id, flow_name) in clashed {
        issues.push(ValidationIssue::warning_with_node(
            "GROUP_AWAIT_PATH_CLASH",
            format!(
                "\"{}\" waits for a callback at a path something else in this run also waits \
                 for. Nothing is consumed when a wait succeeds, so one callback satisfies both.",
                flow_name
            ),
            &group_node_id,
        ));
    }

    // --- A sub-flow's own flow variable, lost to this flow's -------------------------------
    //
    // Taken from the splice's own notes rather than compared here, so the warning cannot claim
    // one thing while the run does another.
    let group_for_flow: HashMap<&str, &str> = inlined
        .origins
        .iter()
        .map(|o| (o.flow_name.as_str(), o.group_node_id.as_str()))
        .collect();
    for note in &inlined.notes {
        let crate::execution::InlineNote::FlowVarShadowed { name, flow_name } = note;
        let message = format!(
            "\"{}\" sets the flow variable {} too. This flow's value wins, so the sub-flow runs \
             with a value it did not choose.",
            flow_name, name
        );
        match group_for_flow.get(flow_name.as_str()) {
            Some(node_id) => issues.push(ValidationIssue::warning_with_node(
                "FLOW_VAR_SHADOWED",
                message,
                node_id,
            )),
            None => issues.push(ValidationIssue::warning("FLOW_VAR_SHADOWED", message)),
        }
    }

    issues
}

/// Two or more steps waiting on the same inbox.
///
/// A wait *filters* the inbox, it does not consume from it: nothing is removed or marked when a
/// wait is satisfied. So two steps on one path with a count of 1 each do not take one callback
/// apiece — the second re-reads the same inbox and the same callback satisfies it, immediately.
///
/// A warning rather than an error, because there is a real reading of it: two steps asserting
/// different things about the *same* report. What must not happen is an author believing they
/// have waited for two.
///
/// Compared as authored, not as resolved. Two nodes both holding `dr/{{dr_path}}` are the same
/// inbox whatever it resolves to, which is exactly the case worth catching, and run time is the
/// only place a resolved path exists.
fn await_path_clashes(nodes: &[GraphNode]) -> Vec<ValidationIssue> {
    use std::collections::HashMap;

    let mut by_path: HashMap<&str, Vec<&GraphNode>> = HashMap::new();
    for node in nodes.iter().filter(|n| n.node_type == "awaitCallback") {
        let path = node
            .data
            .get("config")
            .and_then(|c| c.get("awaitCallback"))
            .and_then(|c| c.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        // A blank path is AWAIT_WITHOUT_PATH's business. Two of them are not a clash, they are
        // two unconfigured steps, and saying both things about one node is noise.
        if !path.is_empty() {
            by_path.entry(path).or_default().push(node);
        }
    }

    let mut issues = Vec::new();
    for (path, sharing) in by_path {
        if sharing.len() < 2 {
            continue;
        }
        // A `match` is the author saying which callback is theirs, which is the whole answer to
        // sharing an inbox — several tests in flight, reports arriving in any order, each wait
        // picking out its own by correlation id. Warning then would be warning about the fix.
        if sharing.iter().all(|n| {
            n.data
                .get("config")
                .and_then(|c| c.get("awaitCallback"))
                .and_then(|c| c.get("match"))
                .and_then(|v| v.as_str())
                .is_some_and(|m| !m.trim().is_empty())
        }) {
            continue;
        }
        // One issue per node, so every node involved is marked on the canvas rather than
        // whichever one happened to be first.
        for node in &sharing {
            issues.push(ValidationIssue::warning_with_node(
                "AWAIT_PATH_SHARED",
                format!(
                    "{} steps wait for a callback at {} — nothing is consumed when a wait \
                     succeeds, so one callback satisfies them all. To wait for {} callbacks, \
                     use one step with a count of {}",
                    sharing.len(),
                    path,
                    sharing.len(),
                    sharing.len()
                ),
                &node.id,
            ));
        }
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

    let mut issues = Vec::new();
    if path.is_empty() {
        issues.push(ValidationIssue::error_with_node(
            "AWAIT_WITHOUT_PATH",
            "This step waits for a callback but no path is set — give it the path your test \
             puts in its callback URL"
                .to_string(),
            &node.id,
        ));
    }

    // Set to run once per item, with no list to walk. Checked here as well as for a request node
    // because the panel can be left in exactly that state — the toggle flipped and the list box
    // never filled — and the *silent* outcome is the dangerous one: the step then runs once,
    // waiting for a single callback while the author believes it is waiting for one per message.
    if let Some(spec) = node.data.get("config").and_then(|c| c.get("forEach")) {
        let list = spec
            .get("list")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().trim_start_matches("{{").trim_end_matches("}}").trim())
            .unwrap_or("");
        if list.is_empty() {
            issues.push(ValidationIssue::error_with_node(
                "FOREACH_WITHOUT_LIST",
                "This step is set to wait once per item, but no list is named — it cannot run. \
                 Open the node and pick the list to walk"
                    .to_string(),
                &node.id,
            ));
        }
    }

    issues
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


    /// An await node with a path, for the clash rule.
    fn waiter(id: &str, path: &str) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: "awaitCallback".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({ "config": { "awaitCallback": { "path": path } } }),
            width: None,
            height: None,
        }
    }

    #[test]
    fn two_steps_waiting_on_one_inbox_are_warned_about() {
        // A wait filters the inbox, it does not consume from it, so two steps with a count of 1
        // each do not take one callback apiece — the same one satisfies both, at once. An author
        // who wanted two reports has to be told, because both steps go green.
        let issues = await_path_clashes(&[waiter("w1", "dr/{{dr_path}}"), waiter("w2", "dr/{{dr_path}}")]);
        assert_eq!(codes(issues.clone()), vec!["AWAIT_PATH_SHARED", "AWAIT_PATH_SHARED"]);
        // Both nodes, so the canvas marks each of them rather than whichever came first.
        let marked: std::collections::HashSet<_> =
            issues.iter().filter_map(|i| i.node_id.clone()).collect();
        assert_eq!(marked.len(), 2);
        assert!(issues[0].message.contains("count of 2"), "{}", issues[0].message);
    }

    #[test]
    fn a_warning_not_an_error_because_two_asserts_on_one_report_is_a_real_thing() {
        // Two steps checking different things about the *same* delivery report is legitimate.
        // What must not happen is believing you waited for two.
        let issues = await_path_clashes(&[waiter("w1", "dr/x"), waiter("w2", "dr/x")]);
        assert!(issues.iter().all(|i| i.severity == "warning"));
    }

    #[test]
    fn different_paths_are_not_a_clash() {
        assert!(await_path_clashes(&[waiter("w1", "dr/a"), waiter("w2", "dr/b")]).is_empty());
    }

    #[test]
    fn two_unconfigured_waiters_are_not_a_clash() {
        // Blank is AWAIT_WITHOUT_PATH's business. Saying both things about one node is noise,
        // and "these two share the inbox ''" is not a sentence about anything.
        let issues = await_path_clashes(&[waiter("w1", ""), waiter("w2", "   ")]);
        assert!(issues.is_empty(), "{:?}", codes(issues.clone()));
    }

    #[test]
    fn one_waiter_alone_is_never_a_clash() {
        assert!(await_path_clashes(&[waiter("w1", "dr/x")]).is_empty());
    }

    #[test]
    fn three_sharing_says_three() {
        let issues = await_path_clashes(&[waiter("a", "dr/x"), waiter("b", "dr/x"), waiter("c", "dr/x")]);
        assert_eq!(issues.len(), 3);
        assert!(issues[0].message.contains("3 steps"), "{}", issues[0].message);
        assert!(issues[0].message.contains("count of 3"), "{}", issues[0].message);
    }


    // ---- the validator itself, not just its rules ----------------------------------------
    //
    // Every test above calls one rule function directly, so until this harness existed nothing
    // covered `validate` *calling* them: deleting the `await_path_clashes` line from it left all
    // 320 tests green. The rules were pinned; the wiring was not, and a rule nothing calls is a
    // rule that does not exist.

    struct NoRepos;

    #[async_trait::async_trait]
    impl TestCaseRepository for NoRepos {
        async fn create(&self, _: &str, _: crate::db::models::CreateTestCase) -> Result<TestCase, AppError> { unimplemented!() }
        async fn get_by_id(&self, _: &str) -> Result<Option<TestCase>, AppError> { Ok(None) }
        async fn list_by_project(&self, _: &str, _: crate::db::models::Pagination) -> Result<crate::db::models::PaginatedResponse<TestCase>, AppError> { unimplemented!() }
        async fn update(&self, _: &str, _: crate::db::models::UpdateTestCase) -> Result<TestCase, AppError> { unimplemented!() }
        async fn delete(&self, _: &str) -> Result<(), AppError> { unimplemented!() }
        async fn find_existing_ids(&self, _: &[String]) -> Result<std::collections::HashSet<String>, AppError> {
            Ok(std::collections::HashSet::new())
        }
    }

    #[async_trait::async_trait]
    impl FlowRepository for NoRepos {
        async fn create(&self, _: &str, _: crate::db::models::CreateFlow) -> Result<Flow, AppError> { unimplemented!() }
        async fn get_by_id(&self, _: &str) -> Result<Option<Flow>, AppError> { Ok(None) }
        async fn list_by_project(&self, _: &str, _: crate::db::models::Pagination) -> Result<crate::db::models::PaginatedResponse<Flow>, AppError> { unimplemented!() }
        async fn update(&self, _: &str, _: crate::db::models::UpdateFlow) -> Result<Flow, AppError> { unimplemented!() }
        async fn update_graph(&self, _: &str, _: crate::db::models::UpdateGraphData) -> Result<Flow, AppError> { unimplemented!() }
        async fn delete(&self, _: &str) -> Result<(), AppError> { unimplemented!() }
        async fn find_existing_ids(&self, _: &[String]) -> Result<std::collections::HashSet<String>, AppError> {
            Ok(std::collections::HashSet::new())
        }
        async fn set_group(&self, _: &str, _: Option<&str>) -> Result<Flow, AppError> { unimplemented!() }
    }

    fn flow_of(nodes: Vec<GraphNode>, edges: Vec<crate::db::models::GraphEdge>) -> Flow {
        Flow {
            id: "f1".to_string(),
            project_id: "p1".to_string(),
            name: "flow".to_string(),
            description: None,
            group_id: None,
            graph_data: crate::db::models::GraphData {
                nodes,
                edges,
                canvas_settings: serde_json::json!({}),
                variables: std::collections::HashMap::new(),
            },
            version: 1,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn plain(id: &str, node_type: &str) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({}),
            width: None,
            height: None,
        }
    }

    fn edge(id: &str, from: &str, to: &str) -> crate::db::models::GraphEdge {
        crate::db::models::GraphEdge {
            id: id.to_string(),
            source: from.to_string(),
            target: to.to_string(),
            edge_type: None,
            data: serde_json::Value::Null,
        }
    }

    /// A repository that actually holds the sub-flows, so the splice has something to resolve.
    ///
    /// `NoRepos` returns `None` for everything, which makes every group node a `MISSING_FLOW_REF`
    /// — and that error deliberately suppresses the sub-flow rules, so none of them could be
    /// reached through it.
    struct WithFlows(Vec<Flow>);

    #[async_trait::async_trait]
    impl TestCaseRepository for WithFlows {
        async fn create(&self, _: &str, _: crate::db::models::CreateTestCase) -> Result<TestCase, AppError> { unimplemented!() }
        async fn get_by_id(&self, _: &str) -> Result<Option<TestCase>, AppError> { Ok(None) }
        async fn list_by_project(&self, _: &str, _: crate::db::models::Pagination) -> Result<crate::db::models::PaginatedResponse<TestCase>, AppError> { unimplemented!() }
        async fn update(&self, _: &str, _: crate::db::models::UpdateTestCase) -> Result<TestCase, AppError> { unimplemented!() }
        async fn delete(&self, _: &str) -> Result<(), AppError> { unimplemented!() }
        async fn find_existing_ids(&self, ids: &[String]) -> Result<std::collections::HashSet<String>, AppError> {
            // Every test case referenced exists: this stub is about flows, and a
            // MISSING_TEST_CASE would only add noise to what each test is actually asserting.
            Ok(ids.iter().cloned().collect())
        }
    }

    #[async_trait::async_trait]
    impl FlowRepository for WithFlows {
        async fn create(&self, _: &str, _: crate::db::models::CreateFlow) -> Result<Flow, AppError> { unimplemented!() }
        async fn get_by_id(&self, id: &str) -> Result<Option<Flow>, AppError> {
            Ok(self.0.iter().find(|f| f.id == id).cloned())
        }
        async fn list_by_project(&self, _: &str, _: crate::db::models::Pagination) -> Result<crate::db::models::PaginatedResponse<Flow>, AppError> { unimplemented!() }
        async fn update(&self, _: &str, _: crate::db::models::UpdateFlow) -> Result<Flow, AppError> { unimplemented!() }
        async fn update_graph(&self, _: &str, _: crate::db::models::UpdateGraphData) -> Result<Flow, AppError> { unimplemented!() }
        async fn delete(&self, _: &str) -> Result<(), AppError> { unimplemented!() }
        async fn find_existing_ids(&self, ids: &[String]) -> Result<std::collections::HashSet<String>, AppError> {
            Ok(ids.iter().filter(|id| self.0.iter().any(|f| &&f.id == id)).cloned().collect())
        }
        async fn set_group(&self, _: &str, _: Option<&str>) -> Result<Flow, AppError> { unimplemented!() }
    }

    fn group_node(id: &str, flow_id: &str) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: "group".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({ "flowId": flow_id }),
            width: None,
            height: None,
        }
    }

    /// A sub-flow: start → one step → end. `exports` names what its step declares.
    fn sub_flow_named(id: &str, name: &str, exports: &[&str], inner: GraphNode) -> Flow {
        let mut flow = flow_of(
            vec![plain("start", "start"), inner, plain("end", "end")],
            vec![edge("a", "start", "step"), edge("b", "step", "end")],
        );
        flow.id = id.to_string();
        flow.name = name.to_string();
        if !exports.is_empty() {
            let vars: Vec<serde_json::Value> = exports
                .iter()
                .map(|n| serde_json::json!({ "name": n, "from": "json.id" }))
                .collect();
            flow.graph_data.nodes[1].data["config"] = serde_json::json!({ "outputVars": vars });
        }
        flow
    }

    fn step_node() -> GraphNode {
        GraphNode {
            id: "step".to_string(),
            node_type: "testCase".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({ "testCaseId": "tc1" }),
            width: None,
            height: None,
        }
    }

    /// A parent whose chain is start → g1 → g2 → end, both running `sub`.
    fn parent_invoking_twice() -> Flow {
        flow_of(
            vec![
                plain("start", "start"),
                group_node("g1", "sub"),
                group_node("g2", "sub"),
                plain("end", "end"),
            ],
            vec![
                edge("e1", "start", "g1"),
                edge("e2", "g1", "g2"),
                edge("e3", "g2", "end"),
            ],
        )
    }

    #[tokio::test]
    async fn two_steps_running_one_sub_flow_that_exports_is_refused() {
        // Node ids are namespaced by the splice, so both invocations run. Variable names are
        // not: the second's `new_account_id` overwrites the first's, and the first's cleanup
        // then deletes the second's account — the leak this feature exists to stop, back again
        // through its own cure.
        let sub = sub_flow_named("sub", "Onboard an enterprise", &["new_account_id"], step_node());
        let repos = WithFlows(vec![sub]);
        let validator = GraphValidator::new(&repos, &repos);

        let result = validator.validate(&parent_invoking_twice()).await.unwrap();
        let twice: Vec<&ValidationIssue> = result
            .errors
            .iter()
            .filter(|e| e.code == "SUBFLOW_INVOKED_TWICE")
            .collect();
        assert_eq!(twice.len(), 2, "both steps are marked: {:?}", result.errors);
        // Named on the canvas, and told which variable collides.
        let nodes: Vec<&str> = twice.iter().filter_map(|e| e.node_id.as_deref()).collect();
        assert!(nodes.contains(&"g1") && nodes.contains(&"g2"), "{nodes:?}");
        assert!(twice[0].message.contains("new_account_id"), "{}", twice[0].message);
        assert!(!result.valid);
    }

    #[tokio::test]
    async fn two_steps_running_a_sub_flow_that_exports_nothing_is_only_a_warning() {
        // Nothing to collide, so the flow still runs. Said anyway, because two invocations is
        // more often a mistake than an intention.
        let sub = sub_flow_named("sub", "Ping twice", &[], step_node());
        let repos = WithFlows(vec![sub]);
        let validator = GraphValidator::new(&repos, &repos);

        let result = validator.validate(&parent_invoking_twice()).await.unwrap();
        assert_eq!(
            result.warnings.iter().filter(|w| w.code == "SUBFLOW_INVOKED_TWICE").count(),
            2,
            "{:?}",
            result.warnings
        );
        assert!(result.valid, "errors: {:?}", result.errors);
    }

    #[tokio::test]
    async fn one_step_running_a_sub_flow_is_not_reported_at_all() {
        let sub = sub_flow_named("sub", "Onboard an enterprise", &["new_account_id"], step_node());
        let repos = WithFlows(vec![sub]);
        let validator = GraphValidator::new(&repos, &repos);
        let flow = flow_of(
            vec![plain("start", "start"), group_node("g1", "sub"), plain("end", "end")],
            vec![edge("e1", "start", "g1"), edge("e2", "g1", "end")],
        );

        let result = validator.validate(&flow).await.unwrap();
        let codes: Vec<&str> = result
            .errors
            .iter()
            .chain(result.warnings.iter())
            .map(|i| i.code.as_str())
            .collect();
        assert!(!codes.contains(&"SUBFLOW_INVOKED_TWICE"), "{codes:?}");
        assert!(result.valid, "errors: {:?}", result.errors);
    }

    #[tokio::test]
    async fn a_failure_edge_out_of_a_sub_flow_node_is_reported_dead() {
        // It has no verdict of its own, and a failing step inside it stops the run rather than
        // reaching the sub-flow's exit. Worse, `pick_edge`'s fallback may take it for a reason
        // that has nothing to do with failure.
        let sub = sub_flow_named("sub", "Onboarding", &[], step_node());
        let repos = WithFlows(vec![sub]);
        let validator = GraphValidator::new(&repos, &repos);
        let mut flow = flow_of(
            vec![
                plain("start", "start"),
                group_node("g1", "sub"),
                plain("recover", "end"),
                plain("end", "end"),
            ],
            vec![
                edge("e1", "start", "g1"),
                edge("e2", "g1", "end"),
                edge("e3", "g1", "recover"),
            ],
        );
        flow.graph_data.edges[2].edge_type = Some("failure".to_string());

        let result = validator.validate(&flow).await.unwrap();
        let issue = result
            .warnings
            .iter()
            .find(|w| w.code == "GROUP_FAILURE_EDGE_IGNORED")
            .expect("a dead failure edge should be reported");
        assert_eq!(issue.node_id.as_deref(), Some("g1"));
    }

    #[tokio::test]
    async fn two_invocations_of_a_waiting_sub_flow_clash_on_one_inbox() {
        // Invisible to the ordinary check, which sees a single group node where the run sees a
        // waiting step — and here, two of them on the same path.
        let sub = sub_flow_named("sub", "Send and wait", &[], {
            let mut w = waiter("step", "dr/x");
            w.id = "step".to_string();
            w
        });
        let repos = WithFlows(vec![sub]);
        let validator = GraphValidator::new(&repos, &repos);

        let result = validator.validate(&parent_invoking_twice()).await.unwrap();
        let clashes: Vec<&ValidationIssue> = result
            .warnings
            .iter()
            .filter(|w| w.code == "GROUP_AWAIT_PATH_CLASH")
            .collect();
        assert_eq!(clashes.len(), 2, "{:?}", result.warnings);
        let nodes: Vec<&str> = clashes.iter().filter_map(|w| w.node_id.as_deref()).collect();
        // Attributed to the boxes the author can see, never to a spliced id they cannot.
        assert!(nodes.contains(&"g1") && nodes.contains(&"g2"), "{nodes:?}");
        assert!(nodes.iter().all(|n| !n.contains('\u{1F}')), "{nodes:?}");
    }

    #[tokio::test]
    async fn a_sub_flows_flow_variable_lost_to_this_flows_is_named() {
        // Parent wins, matching the outer-wins ordering everywhere else — so the sub-flow runs
        // with a value it did not choose, and nothing else would say so.
        let mut sub = sub_flow_named("sub", "Onboarding", &[], step_node());
        sub.graph_data
            .variables
            .insert("base_path".to_string(), serde_json::json!("/sub"));
        let repos = WithFlows(vec![sub]);
        let validator = GraphValidator::new(&repos, &repos);
        let mut flow = flow_of(
            vec![plain("start", "start"), group_node("g1", "sub"), plain("end", "end")],
            vec![edge("e1", "start", "g1"), edge("e2", "g1", "end")],
        );
        flow.graph_data
            .variables
            .insert("base_path".to_string(), serde_json::json!("/parent"));

        let result = validator.validate(&flow).await.unwrap();
        let issue = result
            .warnings
            .iter()
            .find(|w| w.code == "FLOW_VAR_SHADOWED")
            .expect("the shadowed variable should be named");
        assert_eq!(issue.node_id.as_deref(), Some("g1"));
        assert!(issue.message.contains("base_path"), "{}", issue.message);
    }

    #[tokio::test]
    async fn a_missing_sub_flow_is_said_once_rather_than_four_ways() {
        // The splice cannot resolve a flow that isn't there either, and its complaints would
        // land on the same node in different words. MISSING_FLOW_REF is the one that helps.
        let repos = WithFlows(vec![]);
        let validator = GraphValidator::new(&repos, &repos);

        let result = validator.validate(&parent_invoking_twice()).await.unwrap();
        let codes: Vec<&str> = result
            .errors
            .iter()
            .chain(result.warnings.iter())
            .map(|i| i.code.as_str())
            .collect();
        assert_eq!(codes.iter().filter(|c| **c == "MISSING_FLOW_REF").count(), 2, "{codes:?}");
        assert!(!codes.contains(&"SUBFLOW_INVOKED_TWICE"), "{codes:?}");
    }

    #[tokio::test]
    async fn the_validator_reports_a_shared_callback_path() {
        let repos = NoRepos;
        let validator = GraphValidator::new(&repos, &repos);
        let flow = flow_of(
            vec![
                plain("start", "start"),
                waiter("w1", "dr/{{dr_path}}"),
                waiter("w2", "dr/{{dr_path}}"),
                plain("end", "end"),
            ],
            vec![
                edge("e1", "start", "w1"),
                edge("e2", "w1", "w2"),
                edge("e3", "w2", "end"),
            ],
        );

        let result = validator.validate(&flow).await.unwrap();
        let codes: Vec<&str> = result.warnings.iter().map(|w| w.code.as_str()).collect();
        assert_eq!(
            codes.iter().filter(|c| **c == "AWAIT_PATH_SHARED").count(),
            2,
            "warnings were {:?}",
            codes
        );
        // A warning, so the flow is still runnable.
        assert!(result.valid, "errors: {:?}", result.errors);
    }

    #[tokio::test]
    async fn the_validator_reports_a_waiter_with_no_path_and_refuses_the_flow() {
        let repos = NoRepos;
        let validator = GraphValidator::new(&repos, &repos);
        let flow = flow_of(
            vec![plain("start", "start"), waiter("w1", ""), plain("end", "end")],
            vec![edge("e1", "start", "w1"), edge("e2", "w1", "end")],
        );

        let result = validator.validate(&flow).await.unwrap();
        assert!(result.errors.iter().any(|e| e.code == "AWAIT_WITHOUT_PATH"), "{:?}", result.errors);
        assert!(!result.valid);
    }

    #[tokio::test]
    async fn a_flow_of_only_waiters_is_not_an_empty_flow() {
        // start → await → end is a real flow, and only expressible because a waiter needs no
        // test case. EMPTY_FLOW counted testCase and group nodes only.
        let repos = NoRepos;
        let validator = GraphValidator::new(&repos, &repos);
        let flow = flow_of(
            vec![plain("start", "start"), waiter("w1", "dr/x"), plain("end", "end")],
            vec![edge("e1", "start", "w1"), edge("e2", "w1", "end")],
        );

        let result = validator.validate(&flow).await.unwrap();
        assert!(
            !result.warnings.iter().any(|w| w.code == "EMPTY_FLOW"),
            "{:?}",
            result.warnings
        );
    }


    #[test]
    fn sharing_an_inbox_is_fine_when_every_wait_says_which_callback_is_its_own() {
        // Correlation is the answer to a shared inbox, not a symptom of one. Warning here would
        // be warning about the fix — and it is the shape the tool now recommends: one path, one
        // match per message.
        let correlated = |id: &str, tx: &str| GraphNode {
            id: id.to_string(),
            node_type: "awaitCallback".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({
                "config": { "awaitCallback": { "path": "dr/shared", "match": tx } }
            }),
            width: None,
            height: None,
        };
        let issues = await_path_clashes(&[
            correlated("w1", "response.query.cTxnId == \"tx-1\""),
            correlated("w2", "response.query.cTxnId == \"tx-2\""),
        ]);
        assert!(issues.is_empty(), "{:?}", codes(issues.clone()));
    }

    #[test]
    fn one_wait_without_a_match_still_makes_a_shared_inbox_a_clash() {
        // Half-correlated is not correlated: the unmatched wait takes whatever arrives first,
        // including the report the other wait was going to identify as its own.
        let bare = waiter("w1", "dr/shared");
        let matched = GraphNode {
            data: serde_json::json!({
                "config": { "awaitCallback": { "path": "dr/shared", "match": "true" } }
            }),
            ..waiter("w2", "dr/shared")
        };
        assert_eq!(
            codes(await_path_clashes(&[bare, matched])),
            vec!["AWAIT_PATH_SHARED", "AWAIT_PATH_SHARED"]
        );
    }


    #[test]
    fn a_wait_set_to_run_per_item_with_no_list_is_an_error() {
        // The state the panel can be left in: the toggle flipped, the list box never filled. The
        // silent outcome is the dangerous one — the step runs *once*, waiting for a single
        // callback while the author believes it waits for one per message.
        let node = GraphNode {
            data: serde_json::json!({
                "config": { "awaitCallback": { "path": "dr/x" }, "forEach": { "list": "  " } }
            }),
            ..waiter("w1", "dr/x")
        };
        assert_eq!(codes(await_errors(&node)), vec!["FOREACH_WITHOUT_LIST"]);
    }

    #[test]
    fn a_wait_per_item_with_a_list_is_fine_braces_and_all() {
        let node = GraphNode {
            data: serde_json::json!({
                "config": { "awaitCallback": { "path": "dr/x" }, "forEach": { "list": "{{sent}}" } }
            }),
            ..waiter("w1", "dr/x")
        };
        assert!(await_errors(&node).is_empty());
    }


    /// A step that collects into `into`, with or without a field to collect.
    fn collector(id: &str, into: &str, with_field: bool) -> GraphNode {
        let vars = if with_field {
            serde_json::json!([{ "name": "campaignId", "path": "$.campaignId" }])
        } else {
            serde_json::json!([])
        };
        GraphNode {
            id: id.to_string(),
            node_type: "testCase".to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({
                "config": { "forEachRow": true, "collect": { "into": into }, "outputVars": vars }
            }),
            width: None,
            height: None,
        }
    }

    /// A step that walks `list` — a wait, or a request; the rule does not care which.
    fn walker(id: &str, node_type: &str, list: &str) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            position: crate::db::models::Position { x: 0.0, y: 0.0 },
            data: serde_json::json!({
                "config": { "awaitCallback": { "path": "dr/x" }, "forEach": { "list": list } }
            }),
            width: None,
            height: None,
        }
    }

    #[test]
    fn walking_a_list_nothing_fills_is_an_error_on_both_nodes() {
        // The real failure: "Collect into: launched" with no output variables, and a waiter set to
        // run once per record. The list is never created, so the waiter fails every run — pointing
        // at itself, while the fix is on the other node.
        let issues = unfillable_lists(&[
            collector("send", "launched", false),
            walker("wait", "awaitCallback", "launched"),
        ]);
        assert_eq!(codes(issues.clone()), vec!["LIST_NEVER_FILLED", "LIST_NEVER_FILLED"]);
        let marked: std::collections::HashSet<_> =
            issues.iter().filter_map(|i| i.node_id.clone()).collect();
        assert_eq!(marked.len(), 2, "the consumer and the producer");
        assert!(marked.contains("send") && marked.contains("wait"));
        assert!(issues.iter().all(|i| i.severity == "error"));
    }

    #[test]
    fn a_collection_with_a_field_is_fine() {
        assert!(unfillable_lists(&[
            collector("send", "launched", true),
            walker("wait", "awaitCallback", "launched"),
        ])
        .is_empty());
    }

    #[test]
    fn a_field_with_a_name_and_no_path_does_not_count_as_filling_it() {
        // A half-typed row collects nothing, and the engine warns about it separately — so it must
        // not silence this.
        let mut node = collector("send", "launched", false);
        node.data = serde_json::json!({
            "config": {
                "forEachRow": true,
                "collect": { "into": "launched" },
                "outputVars": [{ "name": "campaignId", "path": "" }]
            }
        });
        assert_eq!(
            codes(unfillable_lists(&[node, walker("wait", "awaitCallback", "launched")])).len(),
            2
        );
    }

    #[test]
    fn an_empty_collection_nobody_walks_stays_a_warning() {
        // On its own it is only wasteful — FANOUT_COLLECTION_EMPTY's job. It becomes provable only
        // when something consumes the list.
        assert!(unfillable_lists(&[collector("send", "launched", false)]).is_empty());
    }

    #[test]
    fn a_walker_over_a_list_no_step_declares_is_left_alone() {
        // Could be a project variable or a script. Only run time knows, which is why the panel
        // says it as a doubt and the validator says nothing at all.
        assert!(unfillable_lists(&[walker("wait", "awaitCallback", "from_a_script")]).is_empty());
    }

    #[test]
    fn braces_are_forgiven_on_both_ends() {
        let mut producer = collector("send", "launched", false);
        producer.data = serde_json::json!({
            "config": { "collect": { "into": "{{launched}}" }, "outputVars": [] }
        });
        assert_eq!(
            unfillable_lists(&[producer, walker("wait", "awaitCallback", "{{launched}}")]).len(),
            2
        );
    }

    #[tokio::test]
    async fn the_validator_reports_a_list_nothing_fills() {
        let repos = NoRepos;
        let validator = GraphValidator::new(&repos, &repos);
        let flow = flow_of(
            vec![
                plain("start", "start"),
                collector("send", "launched", false),
                walker("wait", "awaitCallback", "launched"),
                plain("end", "end"),
            ],
            vec![
                edge("e1", "start", "send"),
                edge("e2", "send", "wait"),
                edge("e3", "wait", "end"),
            ],
        );
        let result = validator.validate(&flow).await.unwrap();
        assert!(
            result.errors.iter().any(|e| e.code == "LIST_NEVER_FILLED"),
            "{:?}",
            result.errors
        );
        assert!(!result.valid, "it cannot run, so the flow is not valid");
    }


    #[test]
    fn the_message_explains_that_a_record_is_made_of_output_variables() {
        // The author who hit this asked whether naming the list was not enough on its own — which
        // is exactly what "has no output variables" left unsaid. The relationship is the thing to
        // state: `Collect into` is the container, the output variables are its contents.
        let mut producer = collector("send", "launched", false);
        producer.data = serde_json::json!({
            "alias": "Send sms nb message",
            "config": { "collect": { "into": "launched" }, "outputVars": [] }
        });
        let mut consumer = walker("wait", "awaitCallback", "launched");
        consumer.data = serde_json::json!({
            "alias": "Chk drCallback fires",
            "config": { "awaitCallback": { "path": "dr/x" }, "forEach": { "list": "launched" } }
        });

        let issues = unfillable_lists(&[producer, consumer]);
        let on = |id: &str| {
            issues.iter().find(|i| i.node_id.as_deref() == Some(id)).unwrap().message.clone()
        };

        let consumer_msg = on("wait");
        assert!(consumer_msg.contains("only the *name* of the list"), "{consumer_msg}");
        assert!(consumer_msg.contains("made from the output variables"), "{consumer_msg}");
        // Names the step to open, because "that step" is something an author then has to find.
        assert!(consumer_msg.contains("Send sms nb message"), "{consumer_msg}");
        // And shows the shape of the thing to add.
        assert!(consumer_msg.contains("$.campaignId"), "{consumer_msg}");

        let producer_msg = on("send");
        assert!(producer_msg.contains("a record is made from this step's"), "{producer_msg}");
        // Names the step that will fail, so the consequence is visible from the fixable end.
        assert!(producer_msg.contains("Chk drCallback fires"), "{producer_msg}");
    }

    #[test]
    fn an_unnamed_step_is_described_rather_than_given_an_id() {
        // A node id in a sentence is not something an author can look for on a canvas.
        let issues = unfillable_lists(&[
            collector("send", "launched", false),
            walker("wait", "awaitCallback", "launched"),
        ]);
        assert!(
            issues.iter().all(|i| !i.message.contains("send") && !i.message.contains("wait")),
            "{:?}",
            issues.iter().map(|i| &i.message).collect::<Vec<_>>()
        );
        assert!(issues[0].message.contains("the step above"), "{}", issues[0].message);
    }

}
