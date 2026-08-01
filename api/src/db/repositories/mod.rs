//! Repository traits - database abstraction layer
//!
//! Traits define the interface, implementations can be swapped.

use async_trait::async_trait;
use crate::db::models::*;
use crate::error::AppError;

// Re-export implementations
mod flows;
mod projects;
mod runs;
mod suites;
mod test_cases;
mod test_groups;
pub use flows::SqlxFlowRepository;
pub use projects::SqlxProjectRepository;
pub use runs::SqlxRunRepository;
pub use suites::SqlxSuiteRepository;
pub use test_cases::SqlxTestCaseRepository;
pub use test_groups::SqlxTestGroupRepository;

/// Project repository trait
#[async_trait]
pub trait ProjectRepository: Send + Sync {
    async fn create(&self, project: CreateProject) -> Result<Project, AppError>;
    async fn get_by_id(&self, id: &str) -> Result<Option<Project>, AppError>;
    async fn list(&self, pagination: Pagination) -> Result<PaginatedResponse<Project>, AppError>;
    async fn update(&self, id: &str, update: UpdateProject) -> Result<Project, AppError>;
    async fn delete(&self, id: &str) -> Result<(), AppError>;
}

/// Flow repository trait
#[async_trait]
pub trait FlowRepository: Send + Sync {
    async fn create(&self, project_id: &str, flow: CreateFlow) -> Result<Flow, AppError>;
    async fn get_by_id(&self, id: &str) -> Result<Option<Flow>, AppError>;
    async fn list_by_project(&self, project_id: &str, pagination: Pagination) -> Result<PaginatedResponse<Flow>, AppError>;
    async fn update(&self, id: &str, update: UpdateFlow) -> Result<Flow, AppError>;
    async fn update_graph(&self, id: &str, update: UpdateGraphData) -> Result<Flow, AppError>;
    async fn delete(&self, id: &str) -> Result<(), AppError>;
    /// Check which IDs exist (for validation)
    async fn find_existing_ids(&self, ids: &[String]) -> Result<std::collections::HashSet<String>, AppError>;
}

/// Test case repository trait
#[async_trait]
pub trait TestCaseRepository: Send + Sync {
    async fn create(&self, project_id: &str, test_case: CreateTestCase) -> Result<TestCase, AppError>;
    async fn get_by_id(&self, id: &str) -> Result<Option<TestCase>, AppError>;
    async fn list_by_project(&self, project_id: &str, pagination: Pagination) -> Result<PaginatedResponse<TestCase>, AppError>;
    async fn update(&self, id: &str, update: UpdateTestCase) -> Result<TestCase, AppError>;
    async fn delete(&self, id: &str) -> Result<(), AppError>;
    /// Check which IDs exist (for validation)
    async fn find_existing_ids(&self, ids: &[String]) -> Result<std::collections::HashSet<String>, AppError>;
}

/// Suite repository trait
#[async_trait]
pub trait SuiteRepository: Send + Sync {
    async fn create(&self, project_id: &str, input: CreateSuite) -> Result<Suite, AppError>;
    async fn get_by_id(&self, id: &str) -> Result<Option<Suite>, AppError>;
    async fn list_by_project(&self, project_id: &str) -> Result<Vec<Suite>, AppError>;
    async fn update(&self, id: &str, input: UpdateSuite) -> Result<Suite, AppError>;
    async fn delete(&self, id: &str) -> Result<(), AppError>;
}

/// Run history repository trait
///
/// Two write boundaries and no more: once when a run starts, once per member as it
/// finishes. Nothing per node — a fifteen-row fan-out would otherwise put fifteen round
/// trips on the path of a test already waiting on the network.
#[async_trait]
pub trait RunRepository: Send + Sync {
    /// Open a run and return its id. Written before anything executes, so a run in
    /// flight is visible and a server that dies mid-suite leaves a record marked
    /// `running` rather than no trace at all.
    async fn start(&self, input: SuiteRunInput) -> Result<String, AppError>;
    /// Store one member's outcome, its node results, and each fan-out node's rows.
    async fn record_member(&self, suite_run_id: &str, input: FlowRunInput) -> Result<(), AppError>;
    /// Close the run out with its verdict and totals.
    async fn finish(
        &self,
        suite_run_id: &str,
        status: &str,
        totals: RunTotals,
        error_message: Option<String>,
    ) -> Result<(), AppError>;
    /// Newest first, headline columns only — no bodies.
    async fn list(&self, project_id: &str, limit: i64) -> Result<Vec<SuiteRun>, AppError>;
    /// One run in full, bodies unpacked and fan-out rows reattached to their nodes.
    async fn get(&self, id: &str) -> Result<Option<SuiteRun>, AppError>;
    async fn delete(&self, id: &str) -> Result<(), AppError>;
}

/// Test group repository trait
#[async_trait]
pub trait TestGroupRepository: Send + Sync {
    async fn create(&self, project_id: &str, input: CreateTestGroup) -> Result<TestGroup, AppError>;
    async fn list_by_project(&self, project_id: &str) -> Result<Vec<TestGroup>, AppError>;
    async fn update(&self, id: &str, input: UpdateTestGroup) -> Result<TestGroup, AppError>;
    /// Delete a group; its test cases fall back to Ungrouped (group_id = NULL).
    async fn delete(&self, id: &str) -> Result<(), AppError>;
}
