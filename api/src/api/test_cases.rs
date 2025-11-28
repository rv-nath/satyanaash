//! Test Cases API handlers

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;

use crate::db::models::*;
use crate::db::repositories::TestCaseRepository;
use crate::error::AppError;

/// POST /api/v1/projects/:project_id/test-cases - Create a new test case
pub async fn create_test_case(
    State(repo): State<Arc<dyn TestCaseRepository>>,
    Path(project_id): Path<String>,
    Json(input): Json<CreateTestCase>,
) -> Result<(StatusCode, Json<TestCase>), AppError> {
    let test_case = repo.create(&project_id, input).await?;
    Ok((StatusCode::CREATED, Json(test_case)))
}

/// GET /api/v1/projects/:project_id/test-cases - List all test cases for a project
pub async fn list_test_cases(
    State(repo): State<Arc<dyn TestCaseRepository>>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<TestCase>>, AppError> {
    let test_cases = repo.list_by_project(&project_id).await?;
    Ok(Json(test_cases))
}

/// GET /api/v1/test-cases/:id - Get a test case by ID
pub async fn get_test_case(
    State(repo): State<Arc<dyn TestCaseRepository>>,
    Path(id): Path<String>,
) -> Result<Json<TestCase>, AppError> {
    let test_case = repo.get_by_id(&id).await?
        .ok_or_else(|| AppError::NotFound(format!("Test case {} not found", id)))?;
    Ok(Json(test_case))
}

/// PATCH /api/v1/test-cases/:id - Update a test case
pub async fn update_test_case(
    State(repo): State<Arc<dyn TestCaseRepository>>,
    Path(id): Path<String>,
    Json(input): Json<UpdateTestCase>,
) -> Result<Json<TestCase>, AppError> {
    let test_case = repo.update(&id, input).await?;
    Ok(Json(test_case))
}

/// DELETE /api/v1/test-cases/:id - Delete a test case
pub async fn delete_test_case(
    State(repo): State<Arc<dyn TestCaseRepository>>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
