//! Projects API handlers

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;

use crate::db::models::*;
use crate::db::repositories::ProjectRepository;
use crate::error::AppError;

/// POST /api/v1/projects - Create a new project
pub async fn create_project(
    State(repo): State<Arc<dyn ProjectRepository>>,
    Json(input): Json<CreateProject>,
) -> Result<(StatusCode, Json<Project>), AppError> {
    let project = repo.create(input).await?;
    Ok((StatusCode::CREATED, Json(project)))
}

/// GET /api/v1/projects - List all projects (paginated)
pub async fn list_projects(
    State(repo): State<Arc<dyn ProjectRepository>>,
    Query(pagination): Query<Pagination>,
) -> Result<Json<PaginatedResponse<Project>>, AppError> {
    let response = repo.list(pagination).await?;
    Ok(Json(response))
}

/// GET /api/v1/projects/:id - Get a project by ID
pub async fn get_project(
    State(repo): State<Arc<dyn ProjectRepository>>,
    Path(id): Path<String>,
) -> Result<Json<Project>, AppError> {
    let project = repo.get_by_id(&id).await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", id)))?;
    Ok(Json(project))
}

/// PATCH /api/v1/projects/:id - Update a project
pub async fn update_project(
    State(repo): State<Arc<dyn ProjectRepository>>,
    Path(id): Path<String>,
    Json(input): Json<UpdateProject>,
) -> Result<Json<Project>, AppError> {
    let project = repo.update(&id, input).await?;
    Ok(Json(project))
}

/// DELETE /api/v1/projects/:id - Delete a project
pub async fn delete_project(
    State(repo): State<Arc<dyn ProjectRepository>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
