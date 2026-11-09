//! The comment threads an agent reads, always of the set the reviewer is shown.
use super::discover::Diffle;
use crate::protocol::ThreadList;

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
