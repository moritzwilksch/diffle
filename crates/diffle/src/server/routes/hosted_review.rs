//! HTTP operations on a review hosted by the active provider.
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;

use super::{ApiDeps, ApiResult, body};
use crate::protocol::{HostedCommentRequest, HostedReviewSubmit};

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/hosted-review/export", post(export))
        .route("/api/hosted-review/draft", post(draft))
        .route("/api/hosted-review/comments", get(comments).patch(edit_comment).delete(delete_comment))
        .route("/api/hosted-review/thread/reply", post(reply))
        .route("/api/hosted-review/thread/resolved", put(resolve))
        .route("/api/hosted-review/submit", post(submit))
}

/// `threadIds` absent means every open thread, which the generated type cannot tell from none.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedExportRequest {
    thread_ids: Option<Vec<String>>,
}

/// Adds threads to a pending review on the matching pull request.
async fn export(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: HostedExportRequest = body(&raw)?;
    Ok(Json(d.session.export_hosted_review(req.thread_ids).await?).into_response())
}

async fn delete_comment(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    d.session.delete_hosted_pending_comment(body(&raw)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn comments(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.session.hosted_comments().await?).into_response())
}

async fn edit_comment(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    d.session.edit_hosted_pending_comment(body(&raw)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn reply(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    d.session.reply_hosted_thread(body(&raw)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn resolve(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    d.session.resolve_hosted_thread(body(&raw)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn draft(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let request: HostedCommentRequest = body(&raw)?;
    Ok(Json(d.session.send_hosted_comment(request).await?).into_response())
}

async fn submit(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    d.session.submit_hosted_review(body::<HostedReviewSubmit>(&raw)?).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
