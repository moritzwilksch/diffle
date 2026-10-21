//! Patches, file contents, images and search, all behind the snapshot's allowlist.
use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;

use super::{ApiDeps, ApiError, ApiResult, body, query};
use crate::comments::hunks::shown_ranges;
use crate::concurrency::map_limit;
use crate::git::GrepOptions;
use crate::git::is_binary;
use crate::protocol::{
    ChangeStatus, FileQuery, FileResponse, ImageQuery, PatchQuery, SearchContent, SearchMatch, SearchQuery,
    SearchResponse, SearchScope, Side,
};
use crate::server::image::image_type;

/// The most paths one `POST /api/patch` takes: a client loads a review in bounded batches.
const MAX_PATCH_PATHS: usize = 200;
/// Matches one search returns before it reports truncation.
const SEARCH_LIMIT: usize = 500;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/patch", get(patch).post(patch_many))
        .route("/api/file", get(file))
        .route("/api/image", get(image))
        .route("/api/search", get(search))
}

fn text(body: String) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; charset=UTF-8")], body).into_response()
}

async fn patch(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: PatchQuery = query(raw.as_deref())?;
    let snapshotter = d.session.snapshotter()?;
    let Some(path) = q.path.filter(|p| !p.is_empty()) else { return Ok(text(snapshotter.patch_all().await?)) };
    match snapshotter.patch(&path).await? {
        Some(patch) => Ok(text(patch)),
        None => Err(ApiError::not_found("not a changed file")),
    }
}

#[derive(Deserialize)]
struct PatchRequest {
    paths: Vec<String>,
}

async fn patch_many(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let req: PatchRequest = body(&raw)?;
    if req.paths.len() > MAX_PATCH_PATHS {
        return Err(ApiError::bad_request(format!("paths: at most {MAX_PATCH_PATHS} per request")));
    }
    Ok(text(d.session.snapshotter()?.patch_many(&req.paths).await?))
}

async fn file(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: FileQuery = query(raw.as_deref())?;
    let path = q.path.to_string();
    let snap = d.session.snapshotter()?.current().await?;
    // Outside the snapshot only a file the language server named is readable (see `Locator::read_external`).
    let mut found = d.session.read_side(&snap, &path, q.rev).await?;
    if found.is_none()
        && q.rev == Side::New
        && let Some(pool) = &d.lsp
    {
        found = pool.read_external(&path).await;
    }
    let Some(buf) = found else {
        return Err(ApiError::not_found("absent on that side"));
    };
    let binary = is_binary(&buf);
    let contents = if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() };
    Ok(Json(FileResponse { path, contents, binary }).into_response())
}

/// Snapshot files only, under the key `image_key` gives their side.
async fn image(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: ImageQuery = query(raw.as_deref())?;
    let snap = d.session.snapshotter()?.current().await?;
    let buf = d.session.read_image(&snap, &q.path, q.rev, &q.key).await?;
    let Some((buf, kind)) = buf.and_then(|b| image_type(&b).map(|kind| (b, kind))) else {
        return Err(ApiError::not_found("no image under that key"));
    };
    let headers = [
        (header::CONTENT_TYPE, kind),
        (header::CACHE_CONTROL, "private, max-age=31536000, immutable"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        // An <img> from another site sends no Origin, so the origin guard passes it; this blocks the embed.
        (header::HeaderName::from_static("cross-origin-resource-policy"), "same-origin"),
    ];
    Ok((headers, buf).into_response())
}

async fn search(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: SearchQuery = query(raw.as_deref())?;
    let flag = |v: Option<String>| v.as_deref() == Some("1");
    let snapshotter = d.session.snapshotter()?;
    let snap = snapshotter.current().await?;
    // File scope is pinned to the new-side allowlist; global text search covers changed files.
    let mut paths: Option<Vec<String>> = match q.scope {
        SearchScope::Repo => None,
        SearchScope::File => Some(snap.tree.iter().filter(|p| Some(*p) == q.path.as_ref()).cloned().collect()),
        SearchScope::Diff => {
            Some(snap.changed.iter().filter(|f| f.status != ChangeStatus::D).map(|f| f.path.clone()).collect())
        }
    };
    let mut ranges: Option<HashMap<String, Vec<(i64, i64)>>> = None;
    if q.content == SearchContent::Diff {
        let candidates: Vec<_> = snap
            .changed
            .iter()
            .filter(|f| f.status != ChangeStatus::D && !f.binary)
            .filter(|f| paths.as_ref().is_none_or(|p| p.contains(&f.path)))
            .cloned()
            .collect();
        // The snapshotter's cache: the review already loaded most of these patches, and the rest
        // stay cached for it. A file that left the changed set meanwhile has no shown lines.
        let snapshotter = &snapshotter;
        let entries = map_limit(candidates, 8, |file| async move {
            let patch = snapshotter.patch(&file.path).await?.unwrap_or_default();
            Ok::<_, crate::error::Error>((file.path, shown_ranges(&patch, Side::New)))
        })
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
        paths = Some(entries.iter().filter(|(_, spans)| !spans.is_empty()).map(|(p, _)| p.clone()).collect());
        ranges = Some(entries.into_iter().collect());
    }
    let opts = GrepOptions {
        word: flag(q.word.map(|w| w.to_string())),
        ignore_case: flag(q.i.map(|w| w.to_string())),
        regex: flag(q.re.map(|w| w.to_string())),
        paths: paths.as_deref(),
        ranges: ranges.as_ref(),
    };
    let found =
        d.session.repo.grep(&q.q, &snap.new_sha, SEARCH_LIMIT, opts).await.map_err(crate::error::Error::from)?;
    let matches = found.matches.into_iter().map(|m| SearchMatch { path: m.path, line: m.line, text: m.text }).collect();
    Ok(Json(SearchResponse { query: q.q, matches, truncated: found.truncated }).into_response())
}
