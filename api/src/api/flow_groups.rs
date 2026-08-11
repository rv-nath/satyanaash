//! Flow Groups API handlers
//!
//! The same four operations as test groups, over `flow_groups`. Moving a flow *into* a group is
//! not here — it needs the flow repository, so it lives on `flows::move_flow`.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;

use crate::db::models::*;
use crate::db::repositories::FlowGroupRepository;
use crate::error::AppError;

/// POST /api/v1/projects/:project_id/flow-groups - Create a group
pub async fn create_group(
    State(repo): State<Arc<dyn FlowGroupRepository>>,
    Path(project_id): Path<String>,
    Json(input): Json<CreateFlowGroup>,
) -> Result<(StatusCode, Json<FlowGroup>), AppError> {
    let group = repo.create(&project_id, input).await?;
    Ok((StatusCode::CREATED, Json(group)))
}

/// GET /api/v1/projects/:project_id/flow-groups - List groups (newest first)
pub async fn list_groups(
    State(repo): State<Arc<dyn FlowGroupRepository>>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<FlowGroup>>, AppError> {
    let groups = repo.list_by_project(&project_id).await?;
    Ok(Json(groups))
}

/// PATCH /api/v1/flow-groups/:id - Rename a group
pub async fn update_group(
    State(repo): State<Arc<dyn FlowGroupRepository>>,
    Path(id): Path<String>,
    Json(input): Json<UpdateFlowGroup>,
) -> Result<Json<FlowGroup>, AppError> {
    let group = repo.update(&id, input).await?;
    Ok(Json(group))
}

/// DELETE /api/v1/flow-groups/:id - Delete a group (its flows fall back to Ungrouped)
pub async fn delete_group(
    State(repo): State<Arc<dyn FlowGroupRepository>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
