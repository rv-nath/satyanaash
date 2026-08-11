//! The two sides of the callback receiver, on two different listeners.
//!
//! `record` is the only thing exposed to the network, and it is write-only. `read` and `list` are
//! on the main API, which stays on loopback — a delivery report carries phone numbers, so the part
//! anyone can reach must not be able to hand them back.

use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, Method, StatusCode},
    Json,
};
use chrono::Utc;
use std::collections::HashMap;

use crate::error::AppError;
use crate::hooks::{Hooks, Inbox, Received};

/// ANY /hooks/{*path} — record whatever arrived.
///
/// Any method, because a sender's contract is not ours to narrow, and any path, because the author
/// invents them and the server cannot know them in advance. Refusing an unknown path would drop a
/// real delivery report, which is the one failure here that must not be quiet.
///
/// Always 200. A non-2xx is an instruction to retry on most platforms, and we have no reason to
/// ask for one: the request is recorded or the process is gone.
pub async fn record(
    State(hooks): State<Hooks>,
    method: Method,
    Path(path): Path<String>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let body = String::from_utf8_lossy(&body).to_string();
    // Not parsed at all when it is over the cap: `record` would discard the parse anyway, and
    // parsing a megabyte to throw it away is work done for nothing.
    let json = if body.len() > crate::hooks::MAX_BODY_BYTES {
        None
    } else {
        serde_json::from_str(&body).ok()
    };

    hooks.record(Received {
        method: method.to_string(),
        path: path.clone(),
        query: uri.query().map(str::to_string),
        headers: headers
            .iter()
            .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
            .collect::<HashMap<_, _>>(),
        body,
        json,
        truncated: false,
        received_at: Utc::now(),
    });

    tracing::info!("Callback recorded at /hooks/{}", path);
    StatusCode::OK
}

/// GET /api/v1/hooks/{*path} — what has arrived. Loopback only; see the module note.
pub async fn read(
    State(hooks): State<Hooks>,
    Path(path): Path<String>,
) -> Result<Json<Inbox>, AppError> {
    Ok(Json(hooks.inbox(&path)))
}

/// GET /api/v1/hooks — which paths have anything in them.
///
/// For the author who put a URL in a payload and wants to know whether it was called at all,
/// before working out why an assertion failed.
pub async fn list(State(hooks): State<Hooks>) -> Json<Vec<String>> {
    Json(hooks.paths())
}
