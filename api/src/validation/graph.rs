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

use crate::db::models::{Flow, GraphData, GraphNode, GraphEdge};
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
        let has_test_nodes = graph.nodes.iter()
            .any(|n| n.node_type == "testCase" || n.node_type == "group");

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

    /// Check if a flow can be nested into another without creating cycles
    pub async fn can_nest(&self, parent_flow_id: &str, child_flow_id: &str) -> Result<bool, AppError> {
        // Can't nest into self
        if parent_flow_id == child_flow_id {
            return Ok(false);
        }
        // Check if child contains parent (which would create a cycle)
        let has_cycle = self.has_circular_dependency(parent_flow_id, child_flow_id).await?;
        Ok(!has_cycle)
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

#[cfg(test)]
mod tests {
    use super::*;

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
        };

        let reachable = find_reachable_nodes(&graph, "start");
        assert!(reachable.contains("start"));
        assert!(reachable.contains("tc1"));
        assert!(reachable.contains("end"));
        assert!(!reachable.contains("orphan"));
    }
}
