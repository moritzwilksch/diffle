//! The comment threads an agent reads and answers, always of the set the reviewer is shown.
use reqwest::{Method, StatusCode};

use super::server::Diffle;
use crate::error::Error;
use crate::protocol::{CommentAuthor, CommentThread, ReplyCreate, ThreadList};

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

/// Adds the agent's `body` to `thread`, answering the thread as it is now. A thread the shown set
/// lacks, or an empty body, is the agent's to fix.
pub async fn reply(diffle: &Diffle, thread: &str, body: String) -> anyhow::Result<CommentThread> {
    if body.trim().is_empty() {
        return Err(Error::Invalid("the reply is empty".into()).into());
    }
    let id: String = form_urlencoded::byte_serialize(thread.as_bytes()).collect();
    let request = ReplyCreate { body, author: Some(CommentAuthor::Agent) };
    let response = diffle.send(Method::POST, &format!("api/threads/{id}/replies"), Some(&request)).await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(Error::Invalid(format!("no thread {thread} in the review the reviewer is shown")).into());
    }
    Ok(Diffle::success(response).await?.json().await?)
}
