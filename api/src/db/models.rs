//! Domain models for the application

use std::collections::HashMap;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// =============================================================================
// Project
// =============================================================================

/// Project entity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub settings: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Create project request
#[derive(Debug, Clone, Deserialize)]
pub struct CreateProject {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_settings")]
    pub settings: serde_json::Value,
}

/// Update project request
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateProject {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
}

// =============================================================================
// Flow
// =============================================================================

/// Flow entity with embedded graph
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub graph_data: GraphData,
    pub version: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Graph data containing nodes, edges, and canvas settings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GraphData {
    #[serde(default)]
    pub nodes: Vec<GraphNode>,
    #[serde(default)]
    pub edges: Vec<GraphEdge>,
    #[serde(default = "default_canvas_settings")]
    pub canvas_settings: serde_json::Value,
    /// Flow-level variables (scoped between project vars and node vars)
    #[serde(default)]
    pub variables: HashMap<String, serde_json::Value>,
}

/// Graph node (start, end, testCase, group)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub position: Position,
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

/// Node position
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// Graph edge connecting nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub edge_type: Option<String>,
    #[serde(default)]
    pub data: serde_json::Value,
}

/// Create flow request
#[derive(Debug, Clone, Deserialize)]
pub struct CreateFlow {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub graph_data: Option<GraphData>,
}

/// Update flow request (for name/description only, use update_graph for graph changes)
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateFlow {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Required for optimistic locking
    pub version: i32,
}

/// Update graph data request (includes canvas_settings inside graph_data)
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateGraphData {
    pub graph_data: GraphData,
    /// Required for optimistic locking
    pub version: i32,
}

// =============================================================================
// Test Case
// =============================================================================

/// Test case entity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCase {
    pub id: String,
    pub project_id: String,
    /// Owning group; None = Ungrouped
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub name: String,
    // BDD fields (documentation)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub given_condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub then_expected: Option<String>,
    // HTTP request definition
    pub method: String,
    pub endpoint: String,
    pub headers: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    // Variable extraction (declarative, JSONPath-based)
    pub exports: Vec<ExportVariable>,
    // Assertions (JS expression, evaluated in sandboxed runtime)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assertion_script: Option<String>,
    // Pre-test script (Rhai, executed before HTTP request)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_test_script: Option<String>,
    // Data-driven rows. Only the explicit "run all rows" action iterates these;
    // a plain run and any flow run ignore them (the test case as authored is the
    // primary test).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset: Option<Dataset>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Test group entity (single-level bucket for organizing test cases)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestGroup {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Create test group request
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTestGroup {
    pub name: String,
}

/// Update test group request
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTestGroup {
    pub name: String,
}

/// Export variable definition - extracts values from response using JSONPath
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportVariable {
    pub name: String,
    pub json_path: String, // JSONPath expression (e.g., "$.data.token")
}

/// A table of input rows for data-driven testing: the same request run once per
/// row. `columns` carries display order; each row's `values` is keyed by column
/// name.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Dataset {
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<DataRow>,
}

/// One iteration's inputs, with an optional label and its own assertion override.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct DataRow {
    /// Stable client-side id (React keys). The server never interprets it.
    #[serde(default)]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Cell values keyed by column name.
    #[serde(default)]
    pub values: HashMap<String, serde_json::Value>,
    /// Overrides the test case's assertion for this row only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assertion: Option<String>,
}

impl Dataset {
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Label for a row in result tables and log prefixes.
    pub fn label_for(index: usize, row: &DataRow) -> String {
        row.name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Row {}", index + 1))
    }
}

/// Create test case request
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTestCase {
    pub name: String,
    #[serde(default)]
    pub group_id: Option<String>,
    // BDD fields
    #[serde(default)]
    pub given_condition: Option<String>,
    #[serde(default)]
    pub when_action: Option<String>,
    #[serde(default)]
    pub then_expected: Option<String>,
    // HTTP request
    pub method: String,
    pub endpoint: String,
    #[serde(default = "default_headers")]
    pub headers: serde_json::Value,
    #[serde(default)]
    pub payload: Option<String>,
    // Exports and assertions
    #[serde(default)]
    pub exports: Vec<ExportVariable>,
    #[serde(default)]
    pub assertion_script: Option<String>,
    #[serde(default)]
    pub pre_test_script: Option<String>,
    #[serde(default)]
    pub dataset: Option<Dataset>,
}

/// Update test case request
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTestCase {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    // BDD fields
    #[serde(default)]
    pub given_condition: Option<String>,
    #[serde(default)]
    pub when_action: Option<String>,
    #[serde(default)]
    pub then_expected: Option<String>,
    // HTTP request
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub headers: Option<serde_json::Value>,
    #[serde(default)]
    pub payload: Option<String>,
    // Exports and assertions
    #[serde(default)]
    pub exports: Option<Vec<ExportVariable>>,
    #[serde(default)]
    pub assertion_script: Option<String>,
    #[serde(default)]
    pub pre_test_script: Option<String>,
    #[serde(default)]
    pub dataset: Option<Dataset>,
}

// =============================================================================
// Pagination
// =============================================================================

/// Pagination parameters
#[derive(Debug, Clone, Deserialize)]
pub struct Pagination {
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_per_page")]
    pub per_page: u32,
}

impl Default for Pagination {
    fn default() -> Self {
        Self {
            page: 1,
            per_page: 20,
        }
    }
}

/// Paginated response
#[derive(Debug, Clone, Serialize)]
pub struct PaginatedResponse<T> {
    pub data: Vec<T>,
    pub pagination: PaginationMeta,
}

/// Pagination metadata
#[derive(Debug, Clone, Serialize)]
pub struct PaginationMeta {
    pub page: u32,
    pub per_page: u32,
    pub total: u64,
    pub total_pages: u32,
}

// =============================================================================
// Helper functions
// =============================================================================

fn default_settings() -> serde_json::Value {
    serde_json::json!({})
}

fn default_headers() -> serde_json::Value {
    serde_json::json!({})
}

fn default_canvas_settings() -> serde_json::Value {
    serde_json::json!({})
}

fn default_page() -> u32 {
    1
}

fn default_per_page() -> u32 {
    20
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dataset_label_falls_back_to_row_number() {
        let named = DataRow { name: Some("missing email".into()), ..Default::default() };
        let blank = DataRow { name: Some("   ".into()), ..Default::default() };
        let none = DataRow::default();

        assert_eq!(Dataset::label_for(0, &named), "missing email");
        assert_eq!(Dataset::label_for(1, &blank), "Row 2");
        assert_eq!(Dataset::label_for(2, &none), "Row 3");
    }

    #[test]
    fn test_dataset_json_roundtrip_tolerates_missing_fields() {
        // The client may omit name/assertion entirely.
        let json = r#"{"columns":["email"],"rows":[{"id":"r1","values":{"email":"a@b.c"}}]}"#;
        let ds: Dataset = serde_json::from_str(json).unwrap();

        assert_eq!(ds.columns, vec!["email"]);
        assert_eq!(ds.rows.len(), 1);
        assert_eq!(ds.rows[0].name, None);
        assert_eq!(ds.rows[0].assertion, None);
        assert_eq!(ds.rows[0].values["email"], serde_json::json!("a@b.c"));
        assert!(!ds.is_empty());

        // And an empty dataset round-trips as empty (how the UI clears one).
        let empty: Dataset = serde_json::from_str(r#"{"columns":[],"rows":[]}"#).unwrap();
        assert!(empty.is_empty());
    }
}
