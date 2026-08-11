//! Suite CRUD and suite execution.

use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::sse::{Event, Sse},
    Json,
};
use futures::stream::Stream;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::api::executions::{ExecutionState, StartExecutionRequest};
use crate::db::models::{CreateSuite, Suite, UpdateSuite};
use crate::error::AppError;
use crate::execution::{resolve_members, ExecutionEvent, SuiteRun};

pub async fn create_suite(
    State(state): State<ExecutionState>,
    Path(project_id): Path<String>,
    Json(input): Json<CreateSuite>,
) -> Result<(StatusCode, Json<Suite>), AppError> {
    let suite = state.suite_repo.create(&project_id, input).await?;
    Ok((StatusCode::CREATED, Json(suite)))
}

pub async fn list_suites(
    State(state): State<ExecutionState>,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<Suite>>, AppError> {
    Ok(Json(state.suite_repo.list_by_project(&project_id).await?))
}

pub async fn get_suite(
    State(state): State<ExecutionState>,
    Path(id): Path<String>,
) -> Result<Json<Suite>, AppError> {
    state
        .suite_repo
        .get_by_id(&id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("Suite {} not found", id)))
}

pub async fn update_suite(
    State(state): State<ExecutionState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateSuite>,
) -> Result<Json<Suite>, AppError> {
    Ok(Json(state.suite_repo.update(&id, input).await?))
}

pub async fn delete_suite(
    State(state): State<ExecutionState>,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    state.suite_repo.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/suites/:id/execute-stream
///
/// Same event shape as a flow, with member boundaries added. Streaming only: a suite
/// takes minutes, and a client that has to wait for one JSON body learns nothing until
/// it is over.
pub async fn execute_suite_stream(
    State(state): State<ExecutionState>,
    Path(suite_id): Path<String>,
    Json(input): Json<StartExecutionRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let suite = state
        .suite_repo
        .get_by_id(&suite_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Suite {} not found", suite_id)))?;

    let project = state
        .project_repo
        .get_by_id(&suite.project_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Project {} not found", suite.project_id)))?;

    let base_url = project
        .settings
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut environment = crate::api::executions::extract_project_variables(&project.settings);
    for (k, v) in input.environment {
        environment.insert(k, v);
    }

    // Resolved before the response is returned, so "nothing selected" is a 400 the author
    // sees rather than an empty stream they have to interpret.
    let members = resolve_members(&suite, state.flow_repo.as_ref(), state.tc_repo.as_ref()).await?;

    let execution_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(100);

    let flow_repo = state.flow_repo.clone();
    let tc_repo = state.tc_repo.clone();
    let run_repo = state.run_repo.clone();
    let variables = input.variables;
    let debug_mode = input.debug_mode;
    let environment_name = input.environment_name.clone();
    let exec_id = execution_id.clone();
    let hooks = state.hooks.clone();

    tokio::spawn(async move {
        let runner = SuiteRun {
            execution_id: exec_id,
            project_id: suite.project_id.clone(),
            suite_id: Some(suite.id.clone()),
            suite_name: suite.name.clone(),
            environment_name,
            debug_mode,
            base_url,
            flow_repo: flow_repo.as_ref(),
            tc_repo: tc_repo.as_ref(),
            run_repo,
            hooks,
        };
        if let Err(e) = runner.execute(members, environment, variables, tx.clone()).await {
            let _ = tx.send(ExecutionEvent::Error { message: e.to_string() }).await;
        }
    });

    let stream = async_stream::stream! {
        while let Some(event) = rx.recv().await {
            let json = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
            yield Ok(Event::default().data(json));
        }
    };

    Ok(Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}
