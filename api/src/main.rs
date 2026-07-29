//! Satyanaash API - Graph-based HTTP API Testing Framework

mod api;
mod config;
mod db;
mod error;
mod execution;
mod validation;

use std::sync::Arc;

use axum::{
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::api::{executions, flows, groups, projects, test_cases};
use crate::api::executions::ExecutionState;
use crate::config::Config;
use crate::db::pool::init_pool;
use crate::db::repositories::{SqlxFlowRepository, SqlxProjectRepository, SqlxTestCaseRepository, SqlxTestGroupRepository};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load config
    let config = Config::from_env();

    // Initialize logging
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| config.log_level.clone().into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Starting Satyanaash API server...");

    // Initialize database
    let pool = init_pool(&config.database_url).await?;

    // Create repositories
    let project_repo = Arc::new(SqlxProjectRepository::new(pool.clone()));
    let test_case_repo = Arc::new(SqlxTestCaseRepository::new(pool.clone()));
    let test_group_repo = Arc::new(SqlxTestGroupRepository::new(pool.clone()));
    let flow_repo = Arc::new(SqlxFlowRepository::new(pool.clone()));

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)  // TODO: Restrict in production
        .allow_methods(Any)
        .allow_headers(Any);

    // Build project routes
    let project_routes = Router::new()
        .route("/api/v1/projects", post(projects::create_project))
        .route("/api/v1/projects", get(projects::list_projects))
        .route("/api/v1/projects/{id}", get(projects::get_project))
        .route("/api/v1/projects/{id}", patch(projects::update_project))
        .route("/api/v1/projects/{id}", delete(projects::delete_project))
        .with_state(project_repo.clone());

    // Build test case routes
    let test_case_routes = Router::new()
        // Nested under projects (create/list)
        .route("/api/v1/projects/{project_id}/test-cases", post(test_cases::create_test_case))
        .route("/api/v1/projects/{project_id}/test-cases", get(test_cases::list_test_cases))
        // Standalone (get/update/delete by ID)
        .route("/api/v1/test-cases/{id}", get(test_cases::get_test_case))
        .route("/api/v1/test-cases/{id}", patch(test_cases::update_test_case))
        .route("/api/v1/test-cases/{id}", delete(test_cases::delete_test_case))
        .with_state(test_case_repo.clone());

    // Build test group routes
    let group_routes = Router::new()
        .route("/api/v1/projects/{project_id}/groups", post(groups::create_group))
        .route("/api/v1/projects/{project_id}/groups", get(groups::list_groups))
        .route("/api/v1/groups/{id}", patch(groups::update_group))
        .route("/api/v1/groups/{id}", delete(groups::delete_group))
        .with_state(test_group_repo.clone());

    // Build flow routes
    let flow_routes = Router::new()
        // Nested under projects (create/list)
        .route("/api/v1/projects/{project_id}/flows", post(flows::create_flow))
        .route("/api/v1/projects/{project_id}/flows", get(flows::list_flows))
        // Standalone (get/update/delete by ID)
        .route("/api/v1/flows/{id}", get(flows::get_flow))
        .route("/api/v1/flows/{id}", patch(flows::update_flow))
        .route("/api/v1/flows/{id}/graph", put(flows::update_graph))
        .route("/api/v1/flows/{id}/clone", post(flows::clone_flow))
        .route("/api/v1/flows/{id}", delete(flows::delete_flow))
        .with_state(flow_repo.clone());

    // Build execution routes (needs flow, test case, and project repos)
    let execution_state = ExecutionState {
        flow_repo,
        tc_repo: test_case_repo.clone(),
        project_repo: project_repo.clone(),
        steps: Default::default(),
    };
    let execution_routes = Router::new()
        .route("/api/v1/flows/{id}/validate", post(executions::validate_flow))
        .route("/api/v1/flows/{id}/execute", post(executions::execute_flow))
        .route("/api/v1/flows/{id}/execute-stream", post(executions::execute_flow_stream))
        .route("/api/v1/executions/{id}/step", post(executions::step_execution))
        .route("/api/v1/test-cases/{id}/execute", post(executions::execute_test_case))
        .with_state(execution_state);

    // Build router
    let app = Router::new()
        // Health check
        .route("/health", get(health_check))
        .route("/api/v1/health", get(health_check))
        // Merge all route groups
        .merge(project_routes)
        .merge(test_case_routes)
        .merge(group_routes)
        .merge(flow_routes)
        .merge(execution_routes)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    // Start server
    let addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!("Server listening on http://{}", addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Server shut down gracefully");
    Ok(())
}

/// Waits for Ctrl+C signal for graceful shutdown
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C handler");
    info!("Shutdown signal received, stopping server...")
}

/// Health check endpoint
async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "satyanaash-api",
        "version": env!("CARGO_PKG_VERSION")
    }))
}
