//! Repository traits - database abstraction layer
//!
//! Traits define the interface, implementations can be swapped.

use async_trait::async_trait;
use crate::db::models::*;
use crate::error::AppError;

// Re-export implementations
mod file_stores;
mod flows;
mod projects;
mod runs;
mod suites;
mod test_cases;
mod groups;
pub use file_stores::SqlxFileStoreRepository;
pub use flows::SqlxFlowRepository;
pub use projects::SqlxProjectRepository;
pub use runs::SqlxRunRepository;
pub use suites::SqlxSuiteRepository;
pub use test_cases::SqlxTestCaseRepository;
pub use groups::{SqlxFlowGroupRepository, SqlxTestGroupRepository};

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
    /// Move a flow into a group, or out of every group with `None`. Does not touch `version`
    /// or `updated_at` — see `MoveFlow`.
    async fn set_group(&self, id: &str, group_id: Option<&str>) -> Result<Flow, AppError>;
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

/// File store definitions — where a test's files are uploaded so the API can fetch them.
///
/// `config_for` is the only way back to the real credentials, and it is deliberately not part
/// of the type the API returns: `FileStore` has no secret field, so a leak would have to be
/// written on purpose rather than slip in.
#[async_trait]
pub trait FileStoreRepository: Send + Sync {
    async fn list_by_project(&self, project_id: &str) -> Result<Vec<FileStore>, AppError>;
    async fn get_by_id(&self, id: &str) -> Result<Option<FileStore>, AppError>;
    async fn create(&self, project_id: &str, input: CreateFileStore) -> Result<FileStore, AppError>;
    async fn update(&self, id: &str, input: UpdateFileStore) -> Result<FileStore, AppError>;
    async fn delete(&self, id: &str) -> Result<(), AppError>;
    /// The credentials, for server-side use only.
    async fn config_for(&self, id: &str) -> Result<Option<crate::files::StoreConfig>, AppError>;
    async fn name_taken(
        &self,
        project_id: &str,
        name: &str,
        except: Option<&str>,
    ) -> Result<bool, AppError>;
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
    ///
    /// Ad-hoc runs (a flow run by hand, `suite_id IS NULL`) are left out unless asked
    /// for, and counted so the caller can say how many it is not showing. Filtered here
    /// rather than in the client because `limit` would otherwise let a debug loop of
    /// twenty flow runs hide every suite run before the client ever saw them.
    async fn list(
        &self,
        project_id: &str,
        limit: i64,
        include_adhoc: bool,
    ) -> Result<RunListing, AppError>;
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

/// Flow group repository trait.
///
/// The same four operations as `TestGroupRepository` and the same implementation behind it
/// (`repositories::groups`). Two traits rather than one, because axum keys handler state by
/// type: two `Arc<dyn GroupRepository>` in one app could not be told apart.
#[async_trait]
pub trait FlowGroupRepository: Send + Sync {
    async fn create(&self, project_id: &str, input: CreateFlowGroup) -> Result<FlowGroup, AppError>;
    async fn list_by_project(&self, project_id: &str) -> Result<Vec<FlowGroup>, AppError>;
    async fn update(&self, id: &str, input: UpdateFlowGroup) -> Result<FlowGroup, AppError>;
    /// Delete a group; its flows fall back to Ungrouped (group_id = NULL).
    async fn delete(&self, id: &str) -> Result<(), AppError>;
}
