//! Comment threads and viewed marks. Each write broadcasts its invalidation.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use serde::Deserialize;

use super::{ApiDeps, ApiError, ApiResult, body, query};
use crate::comments::format::format_prompt;
use crate::comments::import::parse_imports;
use crate::error::Error;
use crate::protocol::{ClearThreadsQuery, ServerMessage, ThreadQuery, ThreadState, ViewedEntry};
use crate::session::Broadcaster;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/threads", get(threads).post(import).delete(clear))
        .route("/api/threads/export", get(export))
        .route("/api/threads/{id}", delete(remove_thread))
        .route("/api/threads/{id}/replies", post(reply))
        .route("/api/threads/{id}/resolved", put(resolve))
        .route("/api/threads/{id}/messages/{mid}", patch(edit_message).delete(remove_message))
        .route("/api/threads/{id}/messages/{mid}/export", get(export_message))
        .route("/api/github/export", post(github_export))
        .route("/api/viewed", get(viewed).put(set_viewed))
        .route("/api/viewed/bulk", put(set_viewed_bulk))
}

fn text(body: String) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; charset=UTF-8")], body).into_response()
}

fn thread_query(raw: Option<&str>, default: ThreadState) -> ApiResult<ThreadQuery> {
    let mut q: ThreadQuery = query(raw)?;
    q.state.get_or_insert(default);
    Ok(q)
}

async fn threads(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q = thread_query(raw.as_deref(), ThreadState::All)?;
    Ok(Json(d.session.comments()?.threads(&q).await?).into_response())
}

async fn export(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q = thread_query(raw.as_deref(), ThreadState::Open)?;
    Ok(text(format_prompt(&d.session.comments()?.threads(&q).await?)))
}

async fn export_message(State(d): State<Arc<ApiDeps>>, Path((id, mid)): Path<(String, String)>) -> ApiResult {
    let Some(mut thread) = d.session.comments()?.get(&id).await? else { return Err(Error::NotFound(id).into()) };
    let Some(message) = thread.messages.iter().find(|m| m.id == mid).cloned() else {
        return Err(Error::NotFound(mid).into());
    };
    thread.messages = vec![message];
    Ok(text(format_prompt(&[thread])))
}

/// One object or an array. Answers what was created; open duplicates are skipped.
async fn import(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let value: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| ApiError::bad_request("invalid JSON body"))?;
    let imports = parse_imports(&value)?;
    let source = d.session.anchor_source()?;
    let (added, _) = d.session.comments()?.import_threads(imports, &source).await?;
    if !added.is_empty() {
        d.hub.broadcast(ServerMessage::Threads);
    }
    Ok((StatusCode::CREATED, Json(added)).into_response())
}

#[derive(Deserialize)]
struct Body {
    body: String,
}

async fn reply(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, raw: Bytes) -> ApiResult {
    let req: Body = body(&raw)?;
    if req.body.trim().is_empty() {
        return Err(ApiError::bad_request("body: body required"));
    }
    let thread = d.session.comments()?.reply(&id, req.body).await?;
    d.hub.broadcast(ServerMessage::Threads);
    Ok((StatusCode::CREATED, Json(thread)).into_response())
}

async fn edit_message(State(d): State<Arc<ApiDeps>>, Path((id, mid)): Path<(String, String)>, raw: Bytes) -> ApiResult {
    let req: Body = body(&raw)?;
    let thread = d.session.comments()?.edit_message(&id, &mid, req.body).await?;
    d.hub.broadcast(ServerMessage::Threads);
    Ok(Json(thread).into_response())
}

async fn remove_message(State(d): State<Arc<ApiDeps>>, Path((id, mid)): Path<(String, String)>) -> ApiResult {
    let thread = d.session.comments()?.remove_message(&id, &mid).await?;
    d.hub.broadcast(ServerMessage::Threads);
    Ok(thread.map_or_else(|| StatusCode::NO_CONTENT.into_response(), |t| Json(t).into_response()))
}

#[derive(Deserialize)]
struct Resolved {
    resolved: bool,
}

async fn resolve(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, raw: Bytes) -> ApiResult {
    let req: Resolved = body(&raw)?;
    let thread = d.session.comments()?.set_resolved(&id, req.resolved).await?;
    d.hub.broadcast(ServerMessage::Threads);
    Ok(Json(thread).into_response())
}

async fn remove_thread(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>) -> ApiResult {
    d.session.comments()?.remove_thread(&id).await?;
    d.hub.broadcast(ServerMessage::Threads);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `?stale=1` deletes only stale threads; without it, every thread of this mode.
async fn clear(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: ClearThreadsQuery = query(raw.as_deref())?;
    match q.stale.as_deref() {
        Some("1") => drop(d.session.comments()?.remove_stale().await?),
        None => d.session.comments()?.clear().await?,
        Some(other) => return Err(ApiError::bad_request(format!("stale: expected \"1\", got \"{other}\""))),
    }
    d.hub.broadcast(ServerMessage::Threads);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `threadIds` absent means every open thread, which the generated type cannot tell from none.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubExportRequest {
    thread_ids: Option<Vec<String>>,
}

/// Adds threads to a pending review on the matching pull request; the human submits it on GitHub.
async fn github_export(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: GithubExportRequest = body(&raw)?;
    Ok(Json(d.session.export_github(req.thread_ids).await?).into_response())
}

async fn viewed(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.session.comments()?.viewed().await?).into_response())
}

async fn set_viewed(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let entry: ViewedEntry = body(&raw)?;
    let list = d.session.comments()?.set_viewed(&entry.path, &entry.blob, entry.viewed).await?;
    d.hub.broadcast(ServerMessage::Viewed);
    Ok(Json(list).into_response())
}

#[derive(Deserialize)]
struct ViewedBulk {
    entries: Vec<ViewedEntry>,
}

async fn set_viewed_bulk(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: ViewedBulk = body(&raw)?;
    let list = d.session.comments()?.set_viewed_many(req.entries).await?;
    d.hub.broadcast(ServerMessage::Viewed);
    Ok(Json(list).into_response())
}
