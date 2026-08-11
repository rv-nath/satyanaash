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

/// POST /api/v1/flows/:id/clone - Copy a flow, graph and all
///
/// The point is the *graph*: a scenario usually starts as "the last one, with the
/// tail changed", and re-wiring four identical steps by hand is where the typing
/// goes. Node ids are kept — they only have to be unique within their own flow —
/// so every alias, input variable and output variable survives the copy.
pub async fn clone_flow(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(id): Path<String>,
    body: Option<Json<CloneFlow>>,
) -> Result<(StatusCode, Json<Flow>), AppError> {
    let source = repo.get_by_id(&id).await?
        .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", id)))?;

    let requested = body
        .and_then(|Json(b)| b.name)
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());

    let name = match requested {
        Some(name) => name,
        None => next_copy_name(&*repo, &source).await?,
    };

    let flow = repo.create(&source.project_id, CreateFlow {
        name,
        description: source.description.clone(),
        graph_data: Some(source.graph_data.clone()),
    }).await?;

    Ok((StatusCode::CREATED, Json(flow)))
}

async fn next_copy_name(repo: &dyn FlowRepository, source: &Flow) -> Result<String, AppError> {
    let existing = repo
        .list_by_project(&source.project_id, Pagination { page: 1, per_page: 500 })
        .await?;
    let taken: std::collections::HashSet<&str> =
        existing.data.iter().map(|f| f.name.as_str()).collect();
    Ok(copy_name(&source.name, &taken))
}

/// "Signup (copy)", then "Signup (copy 2)" — cloning twice shouldn't leave two
/// flows wearing the same name in the rail.
fn copy_name(base: &str, taken: &std::collections::HashSet<&str>) -> String {
    let first = format!("{} (copy)", base);
    if !taken.contains(first.as_str()) {
        return first;
    }
    (2..)
        .map(|n| format!("{} (copy {})", base, n))
        .find(|candidate| !taken.contains(candidate.as_str()))
        // The range is unbounded, so there is always a free name.
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::copy_name;
    use std::collections::HashSet;

    #[test]
    fn a_copy_gets_a_name_nobody_is_using() {
        let mut taken: HashSet<&str> = HashSet::new();
        taken.insert("Signup");
        assert_eq!(copy_name("Signup", &taken), "Signup (copy)");

        taken.insert("Signup (copy)");
        assert_eq!(copy_name("Signup", &taken), "Signup (copy 2)");

        taken.insert("Signup (copy 2)");
        taken.insert("Signup (copy 3)");
        assert_eq!(copy_name("Signup", &taken), "Signup (copy 4)");
    }

    #[test]
    fn cloning_a_copy_doesnt_stack_suffixes_beyond_one() {
        let mut taken: HashSet<&str> = HashSet::new();
        taken.insert("Signup (copy)");
        // Cloning the copy itself reads oddly whatever we do; keep it predictable.
        assert_eq!(copy_name("Signup (copy)", &taken), "Signup (copy) (copy)");
    }
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

/// PATCH /api/v1/flows/:id/group - Move a flow into a group, or out with a null
///
/// Separate from `update_flow` and without a version: see `MoveFlow`. Nothing validates that the
/// group exists — a bad id lands the flow in a bucket the sidebar does not draw, which reads as
/// Ungrouped, and the alternative is a second repository in this handler's state for a case the
/// UI cannot produce.
pub async fn move_flow(
    State(repo): State<Arc<dyn FlowRepository>>,
    Path(id): Path<String>,
    Json(input): Json<MoveFlow>,
) -> Result<Json<Flow>, AppError> {
    let flow = repo.set_group(&id, input.group_id.as_deref()).await?;
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
