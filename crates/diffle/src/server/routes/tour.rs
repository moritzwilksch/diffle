//! The review's tour: read, replaced by a push the validator accepts, cleared, and commented on.
//! Each change tells clients; a push or a clear moves the threads on the tour.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};

use super::{ApiDeps, ApiError, ApiResult, body};
use crate::comments::activity::Change;
use crate::error::Error;
use crate::iterations::now_ms;
use crate::protocol::{
    CommentAuthor, ServerMessage, Tour, TourPush, TourPushed, TourRejection, TourResponse, TourThreadCreate,
};
use crate::session::Broadcaster;
use crate::tour::TourIndex;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new().route("/api/tour", get(tour).put(push).delete(clear)).route("/api/tour/threads", post(open_thread))
}

async fn tour(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(TourResponse { tour: d.session.tour()?.get().await? }).into_response())
}

/// Checks the document against the current snapshot and files it under that snapshot's key, with
/// any warnings in the answer; 422 with every reason when it fails.
async fn push(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: TourPush = body(&raw)?;
    let snap = d.session.snapshotter()?.current().await?;
    let verdict = crate::tour::check(&d.session, &snap, &req.html).await?;
    if !verdict.errors.is_empty() {
        let rejection = TourRejection { errors: verdict.errors };
        return Ok((StatusCode::UNPROCESSABLE_ENTITY, Json(rejection)).into_response());
    }
    let tour = Tour { html: req.html, pushed_at: now_ms(), version: snap.version };
    let index = TourIndex::read(&tour.html);
    d.session.tour_for(&snap).put(tour.clone()).await?;
    d.hub.broadcast(ServerMessage::Tour);
    let comments = d.session.comments()?;
    // A mode switch meanwhile shows another set, whose threads are on another tour.
    if comments.key() == snap.comment_key {
        let moved =
            comments.relocate_tour(|node, section, element, target| index.relocate(node, section, element, target));
        record(&d, moved.await?);
    }
    Ok(Json(TourPushed { tour, warnings: verdict.warnings }).into_response())
}

async fn clear(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    if d.session.tour()?.clear().await? {
        d.hub.broadcast(ServerMessage::Tour);
        record(&d, d.session.comments()?.relocate_tour(|_, _, _, _| None).await?);
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
    let Some(tour) = d.session.tour()?.get().await? else {
        return Err(Error::Invalid("the review has no tour".into()).into());
    };
    let anchor = TourIndex::read(&tour.html).place(&req.node, &req.target).map_err(Error::Unquotable)?;
    let thread = d.session.comments()?.add_thread(anchor, req.body).await?;
    d.session.record([(None, Change::Thread(thread.id.clone()))]);
    Ok((StatusCode::CREATED, Json(thread)).into_response())
}

/// Logs the threads a push or a clear moved, as the agent's doing.
fn record(d: &ApiDeps, moved: Vec<String>) {
    d.session.record(moved.into_iter().map(|id| (Some(CommentAuthor::Agent), Change::Thread(id))));
}
