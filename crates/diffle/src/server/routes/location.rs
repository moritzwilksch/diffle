//! The review location is shared by pages connected to this server run.
use std::sync::{Arc, Mutex};

use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};

use super::super::ApiDeps;
use crate::protocol::ReviewLocation;

type Location = Arc<Mutex<Option<ReviewLocation>>>;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new().route("/api/review-location", get(read).put(write)).layer(Extension(Location::default()))
}

async fn read(Extension(location): Extension<Location>) -> Response {
    match location.lock().unwrap().clone() {
        Some(position) => Json(position).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn write(Extension(location): Extension<Location>, Json(position): Json<ReviewLocation>) -> StatusCode {
    let mut last = location.lock().unwrap();
    if last.as_ref().is_none_or(|last| last.updated_at < position.updated_at) {
        *last = Some(position);
    }
    StatusCode::NO_CONTENT
}
