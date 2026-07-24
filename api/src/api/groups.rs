//! Test Groups API handlers

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;

use crate::db::models::*;
use crate::db::repositories::TestGroupRepository;
use crate::error::AppError;

/// POST /api/v1/projects/:project_id/groups - Create a group
pub async fn create_group(
    State(repo): State<Arc<dyn TestGroupRepository>>,
    Path(project_id): Path<String>,
    Json(input): Json<CreateTestGroup>,
) -> Result<(StatusCode, Json<TestGroup>), AppError> {
    let group = repo.create(&project_id, input).await?;
    Ok((StatusCode::CREATED, Json(group)))
}

/// GET /api/v1/projects/:project_id/groups - List groups (newest first)
pub async fn list_groups(
    State(repo): State<Arc<dyn TestGroupRepository>>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<TestGroup>>, AppError> {
    let groups = repo.list_by_project(&project_id).await?;
    Ok(Json(groups))
}

/// PATCH /api/v1/groups/:id - Rename a group
pub async fn update_group(
    State(repo): State<Arc<dyn TestGroupRepository>>,
    Path(id): Path<String>,
    Json(input): Json<UpdateTestGroup>,
) -> Result<Json<TestGroup>, AppError> {
    let group = repo.update(&id, input).await?;
    Ok(Json(group))
}

/// DELETE /api/v1/groups/:id - Delete a group (its tests fall back to Ungrouped)
pub async fn delete_group(
    State(repo): State<Arc<dyn TestGroupRepository>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
