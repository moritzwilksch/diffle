use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::get;

use super::{ApiResult, body};
use crate::protocol::FeedbackReply;
use crate::server::ApiDeps;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new().route("/api/feedback", get(pending)).route("/api/feedback/{target}", get(context).post(answer))
}

async fn pending(State(deps): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(deps.session.pending_feedback().await?).into_response())
}

async fn context(State(deps): State<Arc<ApiDeps>>, Path(target): Path<String>) -> ApiResult {
    Ok(Json(deps.session.feedback_context(target).await?).into_response())
}

async fn answer(State(deps): State<Arc<ApiDeps>>, Path(target): Path<String>, raw: Bytes) -> ApiResult {
    let request: FeedbackReply = body(&raw)?;
    Ok(Json(deps.session.answer_feedback(target, request.summary).await?).into_response())
}
