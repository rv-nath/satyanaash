//! Repository traits - database abstraction layer
//!
//! Traits define the interface, implementations can be swapped.

use async_trait::async_trait;
use crate::db::models::*;
use crate::error::AppError;

// Re-export implementations
mod flows;
mod projects;
mod test_cases;
mod test_groups;
pub use flows::SqlxFlowRepository;
pub use projects::SqlxProjectRepository;
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

/// Test group repository trait
#[async_trait]
pub trait TestGroupRepository: Send + Sync {
    async fn create(&self, project_id: &str, input: CreateTestGroup) -> Result<TestGroup, AppError>;
    async fn list_by_project(&self, project_id: &str) -> Result<Vec<TestGroup>, AppError>;
    async fn update(&self, id: &str, input: UpdateTestGroup) -> Result<TestGroup, AppError>;
    /// Delete a group; its test cases fall back to Ungrouped (group_id = NULL).
    async fn delete(&self, id: &str) -> Result<(), AppError>;
}
