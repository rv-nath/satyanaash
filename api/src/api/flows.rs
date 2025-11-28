//! Flows API handlers

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;

use crate::db::models::*;
use crate::db::repositories::FlowRepository;
use crate::error::AppError;

/// POST /api/v1/projects/:project_id/flows - Create a new flow
pub async fn create_flow(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(project_id): Path<String>,
    Json(input): Json<CreateFlow>,
) -> Result<(StatusCode, Json<Flow>), AppError> {
    let flow = repo.create(&project_id, input).await?;
    Ok((StatusCode::CREATED, Json(flow)))
}

/// GET /api/v1/projects/:project_id/flows - List all flows for a project (paginated)
pub async fn list_flows(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(project_id): Path<String>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<PaginatedResponse<Flow>>, AppError> {
    let response = repo.list_by_project(&project_id, pagination).await?;
    Ok(Json(response))
}

/// GET /api/v1/flows/:id - Get a flow by ID
pub async fn get_flow(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(id): Path<String>,
) -> Result<Json<Flow>, AppError> {
    let flow = repo.get_by_id(&id).await?
        .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", id)))?;
    Ok(Json(flow))
}

/// PATCH /api/v1/flows/:id - Update a flow (metadata only)
pub async fn update_flow(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(id): Path<String>,
    Json(input): Json<UpdateFlow>,
) -> Result<Json<Flow>, AppError> {
    let flow = repo.update(&id, input).await?;
    Ok(Json(flow))
}

/// PUT /api/v1/flows/:id/graph - Update graph data (with optimistic locking)
pub async fn update_graph(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(id): Path<String>,
    Json(input): Json<UpdateGraphData>,
) -> Result<Json<Flow>, AppError> {
    let flow = repo.update_graph(&id, input).await?;
    Ok(Json(flow))
}

/// DELETE /api/v1/flows/:id - Delete a flow
pub async fn delete_flow(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
