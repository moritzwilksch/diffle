//! Comment threads and viewed marks. A thread write is logged as activity, which tells clients; a
//! viewed mark broadcasts its own invalidation.
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::{ApiDeps, ApiError, ApiResult, body, query};
use crate::comments::activity::{Change, Cursor, Since};
use crate::comments::format::format_prompt;
use crate::comments::import::parse_imports;
use crate::error::Error;
use crate::protocol::{
    Activity, ActivityQuery, AuthorQuery, ClearThreadsQuery, CommentAuthor, MessagePatch, ReplyCreate, ResolvedRequest,
    ServerMessage, ThreadQuery, ThreadState, ViewedEntry,
};
use crate::session::Broadcaster;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/threads", get(threads).post(import).delete(clear))
        .route("/api/threads/export", get(export))
        .route("/api/threads/activity", get(activity))
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

/// Logs a change to each thread, by its author (absent: the reviewer).
fn changed(d: &ApiDeps, threads: impl IntoIterator<Item = (Option<CommentAuthor>, String)>) {
    d.session.record(threads.into_iter().map(|(author, id)| (author, Change::Thread(id))));
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
        changed(&d, added.iter().map(|t| (t.messages[0].author, t.id.clone())));
    }
    Ok((StatusCode::CREATED, Json(added)).into_response())
}

async fn reply(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, raw: Bytes) -> ApiResult {
    let req: ReplyCreate = body(&raw)?;
    if req.body.trim().is_empty() {
        return Err(ApiError::bad_request("body: body required"));
    }
    let thread = d.session.comments()?.reply(&id, req.body, req.author).await?;
    changed(&d, [(req.author, id)]);
    Ok((StatusCode::CREATED, Json(thread)).into_response())
}

async fn edit_message(State(d): State<Arc<ApiDeps>>, Path((id, mid)): Path<(String, String)>, raw: Bytes) -> ApiResult {
    let req: MessagePatch = body(&raw)?;
    let thread = d.session.comments()?.edit_message(&id, &mid, req.body).await?;
    changed(&d, [(req.author, id)]);
    Ok(Json(thread).into_response())
}

async fn remove_message(
    State(d): State<Arc<ApiDeps>>,
    Path((id, mid)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> ApiResult {
    let q: AuthorQuery = query(raw.as_deref())?;
    let thread = d.session.comments()?.remove_message(&id, &mid).await?;
    changed(&d, [(q.author, id)]);
    Ok(thread.map_or_else(|| StatusCode::NO_CONTENT.into_response(), |t| Json(t).into_response()))
}

async fn resolve(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, raw: Bytes) -> ApiResult {
    let req: ResolvedRequest = body(&raw)?;
    let thread = d.session.comments()?.set_resolved(&id, req.resolved).await?;
    changed(&d, [(req.author, id)]);
    Ok(Json(thread).into_response())
}

async fn remove_thread(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: AuthorQuery = query(raw.as_deref())?;
    d.session.comments()?.remove_thread(&id).await?;
    changed(&d, [(q.author, id)]);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `?stale=1` deletes only stale threads; without it, every thread of this mode.
async fn clear(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: ClearThreadsQuery = query(raw.as_deref())?;
    let gone = match q.stale.as_deref() {
        Some("1") => d.session.comments()?.remove_stale().await?,
        None => d.session.comments()?.clear().await?,
        Some(other) => return Err(ApiError::bad_request(format!("stale: expected \"1\", got \"{other}\""))),
    };
    changed(&d, gone.into_iter().map(|id| (q.author, id)));
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Waits for the next change after `since` not by `ignore`, then answers what changed; see `Activity`.
async fn activity(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: ActivityQuery = query(raw.as_deref())?;
    let timeout = match q.timeout.as_deref() {
        None => None,
        Some(secs) => Some(Duration::from_secs(
            secs.parse().map_err(|_| ApiError::bad_request(format!("timeout: not a number of seconds: {secs}")))?,
        )),
    };
    let Some(since) = q.since else { return Ok(Json(everything(&d, false).await?).into_response()) };
    let cursor = Cursor::parse(&since).ok_or_else(|| ApiError::bad_request(format!("since: not a cursor: {since}")))?;
    // Subscribed before the first look, so a change between a look and the wait still wakes it.
    let mut messages = d.hub.messages();
    // A deadline past what the clock can name is no deadline.
    let deadline = timeout.and_then(|t| Instant::now().checked_add(t));
    let found = loop {
        match d.session.activity().since(&cursor, q.ignore) {
            Since::Lost => break everything(&d, true).await?,
            // After a key switch, the threads named belong to the set left behind.
            Since::Changed { through, threads, key } => {
                break shown(&d, through, (!key).then_some(threads), false).await?;
            }
            Since::Quiet => {}
        }
        tokio::select! {
            () = d.hub.closed() => break idle(&d, since, true)?,
            () = until(deadline) => break idle(&d, since, false)?,
            received = messages.recv() => if let Err(RecvError::Closed) = received {
                break idle(&d, since, true)?;
            },
        }
    };
    Ok(Json(found).into_response())
}

async fn until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Every thread of the shown set, through the log's latest change.
async fn everything(d: &ApiDeps, resync: bool) -> ApiResult<Activity> {
    shown(d, d.session.activity().cursor(), None, resync).await
}

/// The shown set as it is now, read after the log reached `through`, so a change in between is
/// reported again rather than missed: every thread, or only those `only` names, the gone ones as `removed`.
async fn shown(d: &ApiDeps, through: Cursor, only: Option<BTreeSet<String>>, resync: bool) -> ApiResult<Activity> {
    let store = d.session.comments()?;
    let mut threads = store.threads(&thread_query(None, ThreadState::All)?).await?;
    let mut removed = Vec::new();
    if let Some(mut ids) = only {
        threads.retain(|t| ids.remove(&t.id));
        removed = ids.into_iter().collect();
    }
    let cursor = through.to_string();
    Ok(Activity { cursor, comment_key: store.key().to_owned(), threads, removed, resync, closed: false })
}

/// Nothing to report: the cursor stands.
fn idle(d: &ApiDeps, cursor: String, closed: bool) -> ApiResult<Activity> {
    let comment_key = d.session.comments()?.key().to_owned();
    Ok(Activity { cursor, comment_key, threads: Vec::new(), removed: Vec::new(), resync: false, closed })
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
