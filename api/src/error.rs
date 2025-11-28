//! Application error types and HTTP response conversion

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

/// Application-level error type
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Resource not found: {0}")]
    NotFound(String),

    #[error("Invalid request: {0}")]
    BadRequest(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Version conflict: expected {expected}, got {actual}")]
    VersionConflict { expected: i32, actual: i32 },

    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("HTTP request error: {0}")]
    HttpError(String),

    #[error("Assertion error: {0}")]
    AssertionError(String),
}

/// Error response body
#[derive(Serialize)]
struct ErrorResponse {
    error: String,
    code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<serde_json::Value>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message, details) = match &self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg.clone(), None),
            AppError::BadRequest(msg) => {
                (StatusCode::BAD_REQUEST, "BAD_REQUEST", msg.clone(), None)
            }
            AppError::Conflict(msg) => (StatusCode::CONFLICT, "CONFLICT", msg.clone(), None),
            AppError::VersionConflict { expected, actual } => (
                StatusCode::CONFLICT,
                "VERSION_CONFLICT",
                format!("Version conflict: expected {}, got {}", expected, actual),
                Some(serde_json::json!({
                    "expected_version": expected,
                    "actual_version": actual
                })),
            ),
            AppError::Database(e) => {
                tracing::error!("Database error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "DATABASE_ERROR",
                    "Database error occurred".to_string(),
                    None,
                )
            }
            AppError::Serialization(e) => {
                tracing::error!("Serialization error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "SERIALIZATION_ERROR",
                    "Failed to process data".to_string(),
                    None,
                )
            }
            AppError::Internal(msg) => {
                tracing::error!("Internal error: {}", msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "Internal server error".to_string(),
                    None,
                )
            }
            AppError::HttpError(msg) => (
                StatusCode::BAD_GATEWAY,
                "HTTP_ERROR",
                msg.clone(),
                None,
            ),
            AppError::AssertionError(msg) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "ASSERTION_ERROR",
                msg.clone(),
                None,
            ),
        };

        let body = ErrorResponse {
            error: message,
            code: code.to_string(),
            details,
        };

        (status, Json(body)).into_response()
    }
}

/// Result type alias for handlers
pub type AppResult<T> = Result<T, AppError>;
