//! The review told as a story: its state, and asking the model for one.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;

use super::{ApiDeps, ApiResult};

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new().route("/api/story", get(story).post(generate))
}

async fn story(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.story.state().await?).into_response())
}

/// Starts writing the current snapshot's story, unless one is on record or in progress; answers the
/// state as it is then, and `story` on the socket says when it changes.
async fn generate(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.story.generate().await?).into_response())
}
