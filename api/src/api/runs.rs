//! Reading run history.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::api::executions::ExecutionState;
use crate::db::models::{RunListing, SuiteRun};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
pub struct ListRunsQuery {
    /// How many runs to return, newest first. Capped rather than unbounded: a project
    /// with a year of nightly runs would otherwise send thousands of rows to draw a
    /// list that shows twenty.
    #[serde(default = "default_limit")]
    pub limit: i64,
    /// Include runs of a single flow started by hand. Off by default: running a flow is
    /// how you author one, and twenty of those would bury last night's suite run.
    #[serde(default)]
    pub include_adhoc: bool,
}

fn default_limit() -> i64 {
    50
}

/// GET /api/v1/projects/:id/runs — headlines only, no bodies.
pub async fn list_runs(
    State(state): State<ExecutionState>,
    Path(project_id): Path<String>,
    Query(query): Query<ListRunsQuery>,
) -> Result<Json<RunListing>, AppError> {
    let limit = query.limit.clamp(1, 500);
    Ok(Json(
        state.run_repo.list(&project_id, limit, query.include_adhoc).await?,
    ))
}

/// GET /api/v1/runs/:id — one run in full, bodies unpacked.
pub async fn get_run(
    State(state): State<ExecutionState>,
    Path(id): Path<String>,
) -> Result<Json<SuiteRun>, AppError> {
    state
        .run_repo
        .get(&id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("Run {} not found", id)))
}

/// DELETE /api/v1/runs/:id
pub async fn delete_run(
    State(state): State<ExecutionState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    state.run_repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
