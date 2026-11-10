//! The review's tour: read, replaced by a push the validator accepts, cleared. Each change tells clients.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;

use super::{ApiDeps, ApiResult, body};
use crate::iterations::now_ms;
use crate::protocol::{ServerMessage, Tour, TourPush, TourRejection, TourResponse};
use crate::session::Broadcaster;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new().route("/api/tour", get(tour).put(push).delete(clear))
}

async fn tour(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(TourResponse { tour: d.session.tour()?.get().await? }).into_response())
}

/// Checks the document against the current snapshot and files it under that snapshot's key; 422
/// with every reason when it fails.
async fn push(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: TourPush = body(&raw)?;
    let snap = d.session.snapshotter()?.current().await?;
    let errors = crate::tour::refusals(&d.session, &snap, &req.html).await?;
    if !errors.is_empty() {
        return Ok((StatusCode::UNPROCESSABLE_ENTITY, Json(TourRejection { errors })).into_response());
    }
    let tour = Tour { html: req.html, pushed_at: now_ms(), version: snap.version };
    d.session.tour_for(&snap).put(tour.clone()).await?;
    d.hub.broadcast(ServerMessage::Tour);
    Ok(Json(tour).into_response())
}

async fn clear(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    if d.session.tour()?.clear().await? {
        d.hub.broadcast(ServerMessage::Tour);
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
