//! The comment threads an agent reads and answers, always of the set the reviewer is shown.
use reqwest::{Method, StatusCode};

use super::server::Diffle;
use crate::error::Error;
use crate::protocol::{ApiError, CommentThread, FeedbackContext, FeedbackItem, FeedbackReply, ThreadList};

/// The shown set's threads in `state` (all by default), on `path` alone when given.
pub async fn list(diffle: &Diffle, state: Option<&str>, path: Option<&str>) -> anyhow::Result<ThreadList> {
    let mut query = form_urlencoded::Serializer::new(String::new());
    if let Some(state) = state {
        query.append_pair("state", state);
    }
    if let Some(path) = path {
        query.append_pair("path", path);
    }
    diffle.get(&format!("api/threads?{}", query.finish())).await
}

pub async fn pending(diffle: &Diffle) -> anyhow::Result<Vec<FeedbackItem>> {
    diffle.get("api/feedback").await
}

pub async fn context(diffle: &Diffle, target: &str) -> anyhow::Result<FeedbackContext> {
    let response = diffle.send(Method::GET, &target_path(target), None::<&()>).await?;
    feedback_response(response).await
}

pub async fn reply(diffle: &Diffle, target: &str, body: String) -> anyhow::Result<CommentThread> {
    let request = FeedbackReply { summary: body };
    let response = diffle.send(Method::POST, &target_path(target), Some(&request)).await?;
    feedback_response(response).await
}

fn target_path(target: &str) -> String {
    let id: String = form_urlencoded::byte_serialize(target.as_bytes()).collect();
    format!("api/feedback/{id}")
}

async fn feedback_response<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> anyhow::Result<T> {
    if matches!(response.status(), StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND) {
        let error = response.json::<ApiError>().await?;
        return Err(Error::Invalid(error.error).into());
    }
    Ok(Diffle::success(response).await?.json().await?)
}
