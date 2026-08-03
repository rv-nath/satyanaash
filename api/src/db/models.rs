//! Domain models for the application

use std::collections::{BTreeMap, HashMap};
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

/// Clone flow request. The name is optional — the server picks "<name> (copy)".
#[derive(Debug, Clone, Deserialize, Default)]
pub struct CloneFlow {
    #[serde(default)]
    pub name: Option<String>,
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
    /// How to read `payload`: verbatim (`json`, the default and what every test case
    /// written before this does) or as key/value form fields (`urlencoded`, `multipart`).
    /// See `execution/body.rs` for why there is no second column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_type: Option<String>,
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
/// row, each row supplying the body to send and the status it should return.
///
/// Deliberately not a spreadsheet of named columns — the author pastes exactly
/// what goes on the wire, so there is no template-variable model to learn.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Dataset {
    #[serde(default)]
    pub rows: Vec<DataRow>,
}

/// One case: a label, the body to send, and the status expected back.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct DataRow {
    /// Stable client-side id (React keys). The server never interprets it.
    #[serde(default)]
    pub id: String,
    /// Human label for this case, shown in the results table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Body to send instead of the test case's payload. Still interpolated, so
    /// {{variables}} and {{$Random...}} macros work inside it. Absent (or blank)
    /// means "use the test case's payload".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// What must be true for this row to pass. Either a bare status code ("400",
    /// shorthand for `response.status == 400`) or a Rhai expression
    /// (`response.status == 201 && response.json.token != ()`). Blank means
    /// "any 2xx". Kept as a string so a blank field is simply "not specified".
    ///
    /// The alias reads rows stored before this was widened from a status code to a
    /// full check. It is read-only — serializing always writes `check` — so a row
    /// migrates itself the next time it is saved. Without it those rows load with
    /// no check and quietly pass on any 2xx, which for a negative case is the
    /// worst possible failure mode: a green row that tests nothing.
    #[serde(default, alias = "expected_status", skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    /// Appended to the test case's endpoint for this row, so one request can be
    /// varied by URL as well as by body: "?org=acme", "/acme/summary". Interpolated
    /// like the endpoint itself. Blank means the endpoint as authored.
    ///
    /// One field holding what goes on the wire, not one per parameter — the same
    /// reason `body` is a single field: there is no template model to learn first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Set on a row that only means something once something else has happened —
    /// logged in, funded, seeded. **"Run dataset" in the editor skips it**, because
    /// there is nothing there to satisfy it; a flow node runs it like any other row,
    /// since the flow *is* the precondition.
    ///
    /// An instruction to one runner, not a claim about the row. A missing JWT is the
    /// whole point of "empty payload, no jwt" and merely an obstacle to the row after
    /// it, and only the author knows which — so this says where a row can run, never
    /// why.
    ///
    /// Stored as the exception, so every dataset written before it behaves exactly as
    /// it did with no migration and no re-save.
    #[serde(default, skip_serializing_if = "is_not_set")]
    pub needs_flow: bool,
    /// This row isn't finished. It sends nothing, asserts nothing, and cannot fail or
    /// abort anything — a place to park a case while you work out what it should say.
    ///
    /// **Not the same as `needs_flow`, and the difference is the point.** `needs_flow`
    /// says *where* a row can run: the editor skips it, a flow node runs it, because the
    /// flow is the precondition. `disabled` says it runs **nowhere** — `run_rows` skips
    /// it whatever the caller asked for.
    ///
    /// Exists because a row half-written with `??` in its check was treated as a Rhai
    /// expression, failed to parse, was classified an error, and aborted a seven-node
    /// flow. "Not ready" is a fact the author knows; "might break" is a prediction
    /// nobody can make.
    ///
    /// Stored as the exception, like `needs_flow` above.
    #[serde(default, skip_serializing_if = "is_not_set")]
    pub disabled: bool,
    /// Values for the `{{names}}` this request already declares — the path parameters
    /// in `/campaigns/{{channel}}/pause/{{campaignID}}`, so one row can be the SMS
    /// case and the next the email one.
    ///
    /// This is not the `data.*` column model that was tried and dropped. There, the
    /// author had to invent names and rewrite the payload as a template before writing
    /// a single case. Here the names already exist because they are in the URL, and the
    /// editor reads them off it — nothing to declare, nothing to learn. A body is still
    /// overridden wholesale, for exactly the reason it was then.
    ///
    /// A name left out simply isn't set by this row: it resolves from wherever it would
    /// have anyway. Sorted so a saved dataset's JSON doesn't churn on key order.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub vars: BTreeMap<String, String>,
}

/// Keeps `needs_flow: false` out of the stored JSON — an ordinary row says nothing.
fn is_not_set(flag: &bool) -> bool {
    !*flag
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

impl DataRow {
    /// The body this row sends, or None to fall back to the test case's payload.
    pub fn body_override(&self) -> Option<&str> {
        self.body.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    /// This row's URL suffix, if it gave one.
    pub fn path_suffix(&self) -> Option<&str> {
        self.path.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    /// This row's check, if it gave one.
    pub fn check_expr(&self) -> Option<&str> {
        self.check.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    /// A check that is nothing but a status code — the shorthand form. Anything
    /// else is treated as a Rhai expression.
    pub fn expected_status_code(&self) -> Option<u16> {
        self.check_expr()?.parse::<u16>().ok()
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
    #[serde(default)]
    pub body_type: Option<String>,
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
    #[serde(default)]
    pub body_type: Option<String>,
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
// Suites and run history
// =============================================================================

/// A saved selection of flows and standalone tests, run as one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suite {
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// `None` means every flow and test in the project, resolved at run time.
    ///
    /// Absence is how this codebase already says "unset" for a selection — see fan-out's
    /// `rowIds` — and it means a flow added tomorrow is in the suite without anyone
    /// reopening it. `Some(vec![])` is a different thing: it means nothing is selected,
    /// and the run fails saying so rather than quietly doing everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<SuiteMember>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One entry in a suite: a flow to run, or a test case to run on its own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuiteMember {
    pub kind: MemberKind,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberKind {
    Flow,
    Test,
}

impl MemberKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemberKind::Flow => "flow",
            MemberKind::Test => "test",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "flow" => Some(MemberKind::Flow),
            "test" => Some(MemberKind::Test),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateSuite {
    pub name: String,
    #[serde(default)]
    pub members: Option<Vec<SuiteMember>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateSuite {
    pub name: Option<String>,
    /// Absent leaves the selection alone; `Some(None)` resets it to "everything".
    ///
    /// Two levels of Option because "don't touch it" and "set it back to unset" are
    /// different edits and the PATCH has to be able to say both.
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub members: Option<Option<Vec<SuiteMember>>>,
}

/// One press of Run: a suite, or a single flow run ad hoc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteRun {
    pub id: String,
    pub project_id: String,
    /// `None` for an ad-hoc run of one flow, and for a run whose suite was deleted.
    pub suite_id: Option<String>,
    /// What it was called when it ran. Recorded rather than looked up, for the reason
    /// `NodeResult::expected` is: the project may have been renamed or deleted since.
    pub suite_name: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub duration_ms: Option<i64>,
    pub total: i64,
    pub passed: i64,
    pub failed: i64,
    pub errors: i64,
    pub skipped: i64,
    pub environment_name: Option<String>,
    pub error_message: Option<String>,
    /// Filled by `get_run`, left empty by the list endpoint — a history page wants the
    /// headline of a hundred runs, not the bodies.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<FlowRun>,
}

/// One suite member's run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowRun {
    pub id: String,
    pub suite_run_id: String,
    pub ordinal: i64,
    pub member_kind: MemberKind,
    pub flow_id: Option<String>,
    pub test_case_id: Option<String>,
    pub name: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub duration_ms: Option<i64>,
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub results: Vec<crate::execution::NodeResult>,
}

/// A page of run history, and what it is not showing.
///
/// The count travels with the rows because omitting it silently would read as "that is
/// all there is" — the same dishonest completeness a dataset hides when it reports only
/// the rows it ran.
#[derive(Debug, Clone, Serialize)]
pub struct RunListing {
    pub runs: Vec<SuiteRun>,
    /// Ad-hoc runs left out of this page. Zero when they were asked for.
    pub adhoc_hidden: i64,
}

/// What a run needs before it starts. The row is written up front so a run in flight is
/// visible, and so a server that dies mid-suite leaves a run marked `running` rather
/// than no trace of the hour it spent.
#[derive(Debug, Clone)]
pub struct SuiteRunInput {
    pub project_id: String,
    pub suite_id: Option<String>,
    pub suite_name: String,
    pub environment_name: Option<String>,
}

/// One member's outcome, handed over once that member is done.
#[derive(Debug, Clone)]
pub struct FlowRunInput {
    pub ordinal: i64,
    pub member_kind: MemberKind,
    pub flow_id: Option<String>,
    pub test_case_id: Option<String>,
    pub name: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub duration_ms: Option<i64>,
    pub error_message: Option<String>,
    pub results: Vec<crate::execution::NodeResult>,
}

/// Node counts across a whole run. Nodes, not rows — the same rule `ExecutionStats`
/// follows, so `total` means one thing everywhere.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct RunTotals {
    pub total: i64,
    pub passed: i64,
    pub failed: i64,
    pub errors: i64,
    pub skipped: i64,
}

impl RunTotals {
    pub fn add(&mut self, other: &crate::execution::ExecutionStats) {
        self.total += other.total as i64;
        self.passed += other.passed as i64;
        self.failed += other.failed as i64;
        self.errors += other.errors as i64;
        self.skipped += other.skipped as i64;
    }
}

/// A PATCH field that can be "leave it", "clear it", or "set it".
fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(de).map(Some)
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
    fn rows_saved_before_the_rename_still_carry_their_status() {
        // Exactly what is on disk for rows authored against the older shape.
        let stored = r#"{"rows":[
            {"id":"r1","name":"Empty Payload {}","body":"{}","expected_status":"400"}
        ]}"#;
        let ds: Dataset = serde_json::from_str(stored).expect("old shape still reads");
        assert_eq!(ds.rows[0].check.as_deref(), Some("400"));
        assert_eq!(ds.rows[0].expected_status_code(), Some(400));

        // Writing back uses the current name only, so the row migrates on save.
        let out = serde_json::to_string(&ds).unwrap();
        assert!(out.contains(r#""check":"400""#), "{}", out);
        assert!(!out.contains("expected_status"), "{}", out);
    }

    #[test]
    fn test_check_distinguishes_a_status_from_an_expression() {
        let status = DataRow { check: Some(" 400 ".into()), ..Default::default() };
        assert_eq!(status.expected_status_code(), Some(400));
        assert_eq!(status.check_expr(), Some("400"));

        let expr = DataRow {
            check: Some("response.status == 201 && response.json.id != ()".into()),
            ..Default::default()
        };
        // Not a bare number, so it is an expression, not a status shorthand.
        assert_eq!(expr.expected_status_code(), None);
        assert!(expr.check_expr().unwrap().starts_with("response.status"));

        let blank = DataRow { check: Some("   ".into()), ..Default::default() };
        assert_eq!(blank.check_expr(), None);
        assert_eq!(blank.expected_status_code(), None);
    }

    #[test]
    fn test_dataset_json_roundtrip_tolerates_missing_fields() {
        // The client may omit body/expected_status entirely.
        let json = r#"{"rows":[{"id":"r1","name":"empty body","body":"{}","check":"400"}]}"#;
        let ds: Dataset = serde_json::from_str(json).unwrap();
        assert_eq!(ds.rows.len(), 1);
        assert_eq!(ds.rows[0].body_override(), Some("{}"));
        assert_eq!(ds.rows[0].expected_status_code(), Some(400));

        let bare: Dataset = serde_json::from_str(r#"{"rows":[{"id":"r2"}]}"#).unwrap();
        assert_eq!(bare.rows[0].body_override(), None);
        assert_eq!(bare.rows[0].expected_status_code(), None);

        // Blank or non-numeric entries read as "not specified" rather than failing.
        let blank: Dataset =
            serde_json::from_str(r#"{"rows":[{"id":"r3","body":"  ","expected_status":"abc"}]}"#)
                .unwrap();
        assert_eq!(blank.rows[0].body_override(), None);
        assert_eq!(blank.rows[0].expected_status_code(), None);

        assert!(serde_json::from_str::<Dataset>(r#"{"rows":[]}"#).unwrap().is_empty());
    }
}
