//! Domain models for the application

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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Export variable definition - extracts values from response using JSONPath
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportVariable {
    pub name: String,
    pub json_path: String, // JSONPath expression (e.g., "$.data.token")
}

/// Create test case request
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTestCase {
    pub name: String,
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
}

/// Update test case request
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTestCase {
    #[serde(default)]
    pub name: Option<String>,
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
