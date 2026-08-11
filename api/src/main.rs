//! Satyanaash API - Graph-based HTTP API Testing Framework

mod api;
mod config;
mod db;
mod error;
mod execution;
mod files;
mod shutdown;
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

use crate::api::{executions, file_store, flow_groups, flows, groups, projects, runs, suites, test_cases};
use crate::api::executions::ExecutionState;
use crate::config::Config;
use crate::db::pool::init_pool;
use crate::db::repositories::{SqlxFileStoreRepository, SqlxFlowGroupRepository, SqlxFlowRepository, SqlxProjectRepository, SqlxRunRepository, SqlxSuiteRepository, SqlxTestCaseRepository, SqlxTestGroupRepository};

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
    let flow_group_repo = Arc::new(SqlxFlowGroupRepository::new(pool.clone()));
    let run_repo = Arc::new(SqlxRunRepository::new(pool.clone()));
    let suite_repo = Arc::new(SqlxSuiteRepository::new(pool.clone()));
    let file_store_repo = Arc::new(SqlxFileStoreRepository::new(pool.clone()));

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

    // Buckets of flows. Their own router because their own state — and their own route prefix,
    // `flow-groups`, so nothing has to guess whether /groups means tests or flows.
    let flow_group_routes = Router::new()
        .route("/api/v1/projects/{project_id}/flow-groups", post(flow_groups::create_group))
        .route("/api/v1/projects/{project_id}/flow-groups", get(flow_groups::list_groups))
        .route("/api/v1/flow-groups/{id}", patch(flow_groups::update_group))
        .route("/api/v1/flow-groups/{id}", delete(flow_groups::delete_group))
        .with_state(flow_group_repo.clone() as Arc<dyn crate::db::repositories::FlowGroupRepository>);


    // Build flow routes
    let flow_routes = Router::new()
        // Nested under projects (create/list)
        .route("/api/v1/projects/{project_id}/flows", post(flows::create_flow))
        .route("/api/v1/projects/{project_id}/flows", get(flows::list_flows))
        // Standalone (get/update/delete by ID)
        .route("/api/v1/flows/{id}", get(flows::get_flow))
        .route("/api/v1/flows/{id}", patch(flows::update_flow))
        .route("/api/v1/flows/{id}/group", patch(flows::move_flow))
        .route("/api/v1/flows/{id}/graph", put(flows::update_graph))
        .route("/api/v1/flows/{id}/clone", post(flows::clone_flow))
        .route("/api/v1/flows/{id}", delete(flows::delete_flow))
        .with_state(flow_repo.clone());

    // Build execution routes (needs flow, test case, and project repos)
    let execution_state = ExecutionState {
        flow_repo,
        tc_repo: test_case_repo.clone(),
        project_repo: project_repo.clone(),
        run_repo: run_repo.clone(),
        suite_repo: suite_repo.clone(),
        steps: Default::default(),
    };
    let execution_routes = Router::new()
        .route("/api/v1/flows/{id}/validate", post(executions::validate_flow))
        .route("/api/v1/flows/{id}/execute", post(executions::execute_flow))
        .route("/api/v1/flows/{id}/execute-stream", post(executions::execute_flow_stream))
        .route("/api/v1/executions/{id}/step", post(executions::step_execution))
        .route("/api/v1/test-cases/{id}/execute", post(executions::execute_test_case))
        // Suites and run history share the execution state: a suite needs every
        // repository the runner touches, and the history is written by the same runs.
        .route("/api/v1/projects/{project_id}/suites", post(suites::create_suite))
        .route("/api/v1/projects/{project_id}/suites", get(suites::list_suites))
        .route("/api/v1/suites/{id}", get(suites::get_suite))
        .route("/api/v1/suites/{id}", patch(suites::update_suite))
        .route("/api/v1/suites/{id}", delete(suites::delete_suite))
        .route("/api/v1/suites/{id}/execute-stream", post(suites::execute_suite_stream))
        .route("/api/v1/projects/{project_id}/runs", get(runs::list_runs))
        .route("/api/v1/runs/{id}", get(runs::get_run))
        .route("/api/v1/runs/{id}", delete(runs::delete_run))
        .with_state(execution_state);

    // Storages are named and project-scoped, so unlike the earlier per-environment design
    // there is a repository behind them. Secrets live in it write-only — `FileStore` has no
    // field for one, so a credential cannot reach a response without someone adding it.
    //
    // `DefaultBodyLimit` is 2 MB in axum, which would have silently truncated every upload
    // past a small spreadsheet. Raised on the upload route alone, so the one endpoint that has
    // to accept a file does not lift the ceiling on every JSON body in the API.
    let file_store_state = file_store::FileStoreState { repo: file_store_repo };
    let file_store_routes = Router::new()
        .route("/api/v1/projects/{project_id}/file-stores", get(file_store::list_stores))
        .route("/api/v1/projects/{project_id}/file-stores", post(file_store::create_store))
        .route("/api/v1/projects/{project_id}/file-stores/test", post(file_store::test_draft))
        // Both take a draft, not a saved id: they answer while the form is being filled in, which
        // is the only moment they are useful.
        .route("/api/v1/projects/{project_id}/file-stores/buckets", post(file_store::list_buckets))
        .route(
            "/api/v1/projects/{project_id}/file-stores/create-bucket",
            post(file_store::create_bucket),
        )
        .route("/api/v1/file-stores/{id}", patch(file_store::update_store))
        .route("/api/v1/file-stores/{id}", delete(file_store::delete_store))
        .route("/api/v1/file-stores/{id}/test", post(file_store::test_store))
        .route("/api/v1/file-stores/{id}/files", get(file_store::list_files))
        .route(
            "/api/v1/file-stores/{id}/files",
            post(file_store::upload)
                .layer(axum::extract::DefaultBodyLimit::max(crate::files::MAX_UPLOAD_BYTES as usize)),
        )
        .route("/api/v1/file-stores/{id}/files", delete(file_store::delete_file))
        .with_state(file_store_state);

    // Build router
    let app = Router::new()
        // Health check
        .route("/health", get(health_check))
        .route("/api/v1/health", get(health_check))
        // Merge all route groups
        .merge(project_routes)
        .merge(test_case_routes)
        .merge(group_routes)
        .merge(flow_group_routes)
        .merge(flow_routes)
        .merge(execution_routes)
        .merge(file_store_routes)
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

/// Ctrl+C once to stop safely, twice to stop now.
///
/// The first press used to be received and then effectively ignored: graceful shutdown
/// waits for open connections, a suite's SSE stream stays open for as long as the suite
/// runs, and pressing again did nothing because this future had already completed. The
/// server would sit there for minutes still creating accounts.
async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to install Ctrl+C handler");
    info!(
        "Shutdown requested — runs will stop at their next step, and their cleanup will \
         still run. Press Ctrl+C again to exit immediately."
    );
    shutdown::request_stop();

    // Armed only after the first press, so an impatient second one is heard. Exiting the
    // process outright skips any cleanup still owed, which is why it takes asking twice.
    tokio::spawn(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::warn!("Second interrupt — exiting now. Cleanup steps may not have run.");
            std::process::exit(130);
        }
    });
}

/// Health check endpoint
async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "satyanaash-api",
        "version": env!("CARGO_PKG_VERSION")
    }))
}
