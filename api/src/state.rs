//! Application state shared across handlers

use crate::db::repositories::{
    ExecutionRepository, FlowRepository, ProjectRepository, TestCaseRepository,
};
use std::sync::Arc;

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    pub projects: Arc<dyn ProjectRepository>,
    pub flows: Arc<dyn FlowRepository>,
    pub test_cases: Arc<dyn TestCaseRepository>,
    pub executions: Arc<dyn ExecutionRepository>,
}
