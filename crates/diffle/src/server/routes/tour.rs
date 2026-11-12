//! The review's tour: read, replaced by a push the validator accepts, cleared, and commented on.
//! Each change tells clients; a push or a clear moves the threads on the tour in the same write.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};

use super::{ApiDeps, ApiError, ApiResult, body};
use crate::comments::activity::Change;
use crate::error::Error;
use crate::iterations::now_ms;
use crate::protocol::{
    CommentAuthor, ServerMessage, Tour, TourPush, TourPushed, TourRejection, TourResponse, TourThreadCreate, TourTick,
};
use crate::session::Broadcaster;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/tour", get(tour).put(push).delete(clear))
        .route("/api/tour/threads", post(open_thread))
        .route("/api/tour/ticks", put(tick))
}

async fn tour(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    let checks = crate::tour::checklist(&d.session, &[]).await?;
    Ok(Json(TourResponse { tour: d.session.comments()?.tour().await?, checks }).into_response())
}

/// Checks the document against the current snapshot and files it in that snapshot's set, moving the
/// set's threads on the tour in the same write; warnings in the answer, 422 with every reason when
/// it fails.
async fn push(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: TourPush = body(&raw)?;
    let snap = d.session.snapshotter()?.current().await?;
    let verdict = crate::tour::check(&d.session, &snap, &req.html).await?;
    if !verdict.errors.is_empty() {
        let rejection = TourRejection { errors: verdict.errors };
        return Ok((StatusCode::UNPROCESSABLE_ENTITY, Json(rejection)).into_response());
    }
    let tour = Tour { html: req.html, pushed_at: now_ms(), version: snap.version, ticked: Vec::new() };
    let moved = d.session.comments_for(&snap).push_tour(tour.clone()).await?;
    d.hub.broadcast(ServerMessage::Tour);
    record(&d, moved);
    Ok(Json(TourPushed { tour, warnings: verdict.warnings }).into_response())
}

async fn clear(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    if let Some(moved) = d.session.comments()?.clear_tour().await? {
        d.hub.broadcast(ServerMessage::Tour);
        record(&d, moved);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Opens the reviewer's thread on the tour as stored; 400 when the review has none or the target is
/// not in it.
async fn open_thread(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: TourThreadCreate = body(&raw)?;
    if req.body.trim().is_empty() {
        return Err(ApiError::bad_request("body: body required"));
    }
    let thread = d.session.comments()?.add_tour_thread(&req.node, &req.target, req.body).await?;
    d.session.record([(None, Change::Thread(thread.id.clone()))]);
    Ok((StatusCode::CREATED, Json(thread)).into_response())
}

/// Ticks a checklist item of the review's tour, or unticks it; 400 when the review has no tour.
async fn tick(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: TourTick = body(&raw)?;
    if !d.session.comments()?.tick(&req.question, req.ticked).await? {
        return Err(Error::Invalid("the review has no tour".into()).into());
    }
    d.hub.broadcast(ServerMessage::Tour);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Logs the threads a push or a clear moved, as the agent's doing.
fn record(d: &ApiDeps, moved: Vec<String>) {
    d.session.record(moved.into_iter().map(|id| (Some(CommentAuthor::Agent), Change::Thread(id))));
}
