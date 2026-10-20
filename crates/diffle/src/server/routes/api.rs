//! The review itself: its snapshot, mode, iterations, refs and settings.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde::Deserialize;

use super::{ApiDeps, ApiError, ApiResult, body, query};
use crate::protocol::{FollowRefs, LastCommitsQuery, ModeRequest, ServerMessage, UserConfig};
use crate::session::Broadcaster;
use crate::user_config::UserConfigPatch;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/snapshot", get(snapshot))
        .route("/api/moved", get(moved))
        .route("/api/reload", post(reload))
        .route("/api/iterations", delete(clear_iterations))
        .route("/api/iterations/{n}", delete(delete_iteration))
        .route("/api/mode", post(mode))
        .route("/api/github", get(github))
        .route("/api/refs", get(refs))
        .route("/api/last-commits-preview", get(last_commits_preview))
        .route("/api/config", get(config).put(set_config))
}

async fn snapshot(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.session.snapshotter()?.current().await?).into_response())
}

async fn moved(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.session.moved()?).into_response())
}

async fn reload(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.session.reload().await?).into_response())
}

async fn clear_iterations(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.session.clear_iterations().await?).into_response())
}

async fn delete_iteration(State(d): State<Arc<ApiDeps>>, Path(n): Path<String>) -> ApiResult {
    let parsed = n.parse::<i64>().ok().filter(|n| *n >= 1);
    let Some(n) = parsed else { return Err(ApiError::bad_request(format!("not an iteration number: {n}"))) };
    Ok(Json(d.session.delete_iteration(n).await?).into_response())
}

async fn mode(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: ModeRequest = body(&raw)?;
    Ok(Json(d.session.switch_mode(req).await?).into_response())
}

/// Pull request discovery arrives with the GitHub client.
async fn github(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    d.session.snapshotter()?.current().await?;
    Err(crate::error::Error::Github("GitHub is not available in this build yet".into()).into())
}

async fn refs(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.session.repo.refs().await?).into_response())
}

async fn last_commits_preview(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: LastCommitsQuery = query(raw.as_deref())?;
    let offset = |s: &str| {
        let n = s.parse::<u64>().ok().filter(|n| *n <= super::lsp::MAX_SAFE_INTEGER);
        n.ok_or_else(|| ApiError::bad_request(format!("not an offset: {s}")))
    };
    let (old, new) = (offset(&q.old_offset)?, offset(&q.new_offset)?);
    Ok(Json(d.session.repo.last_commits_preview(old, new).await?).into_response())
}

async fn config(State(d): State<Arc<ApiDeps>>) -> Response {
    Json(effective_config(&d)).into_response()
}

/// `ConfigUpdate` as sent: an absent field leaves the setting alone, which the generated type
/// cannot tell from an empty list.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigUpdate {
    auto_viewed: Option<Vec<String>>,
    context_lines: Option<i64>,
    follow_refs: Option<FollowRefs>,
    line_wrap: Option<bool>,
}

async fn set_config(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let update: ConfigUpdate = body(&raw)?;
    if update.context_lines.is_some_and(|n| !(0..=10_000).contains(&n)) {
        return Err(ApiError::bad_request("contextLines: expected an integer between 0 and 10000"));
    }
    let patch = UserConfigPatch {
        auto_viewed: update.auto_viewed,
        context_lines: update.context_lines,
        follow_refs: update.follow_refs,
        line_wrap: update.line_wrap,
        ..Default::default()
    };
    let saved = d.config.set(patch).await?;
    d.hub.broadcast(ServerMessage::Config);
    // The session keeps its own context (`--context` or the config at startup); only an explicit change moves it.
    if update.context_lines.is_some() {
        d.session.set_context(saved.context_lines as u32).await?;
    }
    if update.follow_refs.is_some() {
        d.session.set_follow_refs(saved.follow_refs);
    }
    Ok(Json(effective_config(&d)).into_response())
}

/// The stored config plus this session's additions: `--auto-viewed` globs and the live context.
fn effective_config(d: &ApiDeps) -> UserConfig {
    let mut config = d.config.get();
    for glob in &d.extra_auto_viewed {
        if !config.auto_viewed.contains(glob) {
            config.auto_viewed.push(glob.clone());
        }
    }
    config.context_lines = i64::from(d.session.context());
    config
}
