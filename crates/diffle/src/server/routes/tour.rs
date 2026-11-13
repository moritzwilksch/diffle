//! The review's tour: read, replaced by a push the validator accepts, cleared, commented on, and
//! exported through an open tab. Each change tells clients; a push or a clear moves the threads on
//! the tour in the same write.
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};

use super::{ApiDeps, ApiError, ApiResult, body};
use crate::comments::activity::Change;
use crate::iterations::now_ms;
use crate::protocol::{
    CommentAuthor, ServerMessage, Tour, TourExportAnswer, TourPush, TourPushed, TourRejection, TourResponse,
    TourThreadCreate, TourTick,
};
use crate::session::Broadcaster;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/tour", get(tour).put(push).delete(clear))
        .route("/api/tour/threads", post(open_thread))
        .route("/api/tour/ticks", put(tick))
        .route("/api/tour/export", post(export))
        // `limit_body` caps the baked file; axum's own 2 MB default would refuse a large one.
        .route("/api/tour/exports/{id}", put(answer_export).layer(DefaultBodyLimit::disable()))
}

/// How long a tab may take to bake a tour: a large one hovers every symbol it names.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(60);

async fn tour(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    let tour = d.session.comments()?.tour().await?.map(|stored| stored.tour);
    Ok(Json(TourResponse { tour }).into_response())
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
    let tour = Tour { html: req.html, pushed_at: now_ms() };
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

/// Ticks a checklist item of the review's tour, or unticks it; 400 when the review has no tour or
/// its tour asks no such question.
async fn tick(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: TourTick = body(&raw)?;
    d.session.comments()?.tick(&req.question, req.ticked).await?;
    d.hub.broadcast(ServerMessage::Tour);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// The review's tour as one HTML file, baked by the first open tab to answer; 409 without a tour or
/// a tab, 504 when no tab answers in time, 502 when the tab could not bake it.
async fn export(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    if d.session.comments()?.tour().await?.is_none() {
        return Err(ApiError(StatusCode::CONFLICT, "the review has no tour: push one with `diffle tour push`".into()));
    }
    if d.hub.client_count() == 0 {
        let message = "no browser tab shows the review, and only one can bake the tour: open diffle, then export again";
        return Err(ApiError(StatusCode::CONFLICT, message.into()));
    }
    let mut pending = d.hub.ask_export();
    match tokio::time::timeout(EXPORT_TIMEOUT, &mut pending.answer).await {
        Ok(Ok(TourExportAnswer::Baked { html })) => {
            Ok(([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response())
        }
        Ok(Ok(TourExportAnswer::Failed { error })) => {
            Err(ApiError(StatusCode::BAD_GATEWAY, format!("the tab could not export the tour: {error}")))
        }
        // The sender goes only with an answer, so a closed channel is a timeout by another name.
        Ok(Err(_)) | Err(_) => Err(ApiError(
            StatusCode::GATEWAY_TIMEOUT,
            format!(
                "no browser tab exported the tour within {} s: bring the diffle tab to the front, then export again",
                EXPORT_TIMEOUT.as_secs()
            ),
        )),
    }
}

/// A tab's answer to export `id`; 404 when another tab answered first or the request timed out.
async fn answer_export(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, raw: Bytes) -> ApiResult {
    let answer: TourExportAnswer = body(&raw)?;
    if !d.hub.answer_export(&id, answer) {
        return Err(ApiError::not_found("no export waits for this answer"));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Logs the threads a push or a clear moved, as the agent's doing.
fn record(d: &ApiDeps, moved: Vec<String>) {
    d.session.record(moved.into_iter().map(|id| (Some(CommentAuthor::Agent), Change::Thread(id))));
}
