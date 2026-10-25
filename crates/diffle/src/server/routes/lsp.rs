//! Symbol navigation, answered only while the new side is the checkout the language servers read.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};

use super::{ApiDeps, ApiError, ApiResult, body, query};
use crate::lsp::pool::LspPool;
use crate::protocol::{
    GraphQuery, LspFeature, LspHoverRequest, LspLogQuery, LspPosition, LspQuery, LspStatus, Side, SymbolsQuery,
    lsp_blocker, readable_by_servers,
};

/// The largest integer a JavaScript client can send exactly; zod's `.int()` refuses anything past it.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/lsp/status", get(status))
        .route("/api/lsp/log", get(log))
        .route("/api/lsp/definition", post(definition))
        .route("/api/lsp/type-definition", post(type_definition))
        .route("/api/lsp/hover", post(hover))
        .route("/api/lsp/references", post(references))
        .route("/api/lsp/occurrences", post(occurrences))
        .route("/api/lsp/symbols", get(symbols))
        .route("/api/lsp/graph", get(graph))
}

pub fn lsp_status(d: &ApiDeps) -> LspStatus {
    d.lsp
        .as_ref()
        .map_or_else(|| LspStatus { enabled: false, servers: Vec::new(), missing: Vec::new() }, |p| p.status())
}

async fn status(State(d): State<Arc<ApiDeps>>) -> Response {
    Json(lsp_status(&d)).into_response()
}

/// Readable whatever the snapshot shows: a log explains a server that cannot answer right now.
async fn log(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: LspLogQuery = query(raw.as_deref())?;
    match d.lsp.as_ref().and_then(|p| p.log(&q.server)) {
        Some(entries) => Ok(Json(serde_json::json!({ "entries": entries })).into_response()),
        None => Err(ApiError::not_found("no such language server")),
    }
}

/// The pool, or the 409 reason `lsp_blocker` gives: off, the wrong side, no server, or not that
/// feature. An advisory query names no feature: a server not offering it answers nothing, which is
/// no reason to refuse.
async fn pool_for(d: &ApiDeps, path: Option<&str>, feature: Option<LspFeature>) -> ApiResult<Arc<LspPool>> {
    let snap = d.session.snapshotter()?.current().await?;
    let q = LspQuery { path, feature, patient: true };
    let refuse = |m: String| ApiError(StatusCode::CONFLICT, m);
    if let Some(blocked) = lsp_blocker(&lsp_status(d), readable_by_servers(Some(&snap)), &q) {
        return Err(refuse(blocked));
    }
    let Some(pool) = d.lsp.clone() else { return Err(refuse("language servers are off".into())) };
    // Beyond the snapshot, only a file a running server named may be asked about (see `Locator::origin`).
    if let Some(path) = path.filter(|p| !d.session.has_side(&snap, p, Side::New) && !pool.named(p)) {
        return Err(refuse(format!("{path} is not in the snapshot")));
    }
    Ok(pool)
}

fn position(raw: &[u8]) -> ApiResult<LspPosition> {
    let pos: LspPosition = body(raw)?;
    if pos.col < 0 || pos.col as u64 > MAX_SAFE_INTEGER || pos.line.get() > MAX_SAFE_INTEGER {
        return Err(ApiError::bad_request("line and col: expected safe non-negative integers, line from 1"));
    }
    Ok(pos)
}

async fn definition(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let pos = position(&raw)?;
    let pool = pool_for(&d, Some(&pos.path), Some(LspFeature::Definition)).await?;
    Ok(Json(pool.definition(&pos).await?).into_response())
}

async fn type_definition(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let pos = position(&raw)?;
    let pool = pool_for(&d, Some(&pos.path), Some(LspFeature::TypeDefinition)).await?;
    Ok(Json(pool.type_definition(&pos).await?).into_response())
}

async fn hover(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let pos = position(&raw)?;
    let req: LspHoverRequest = body(&raw)?;
    let pool = pool_for(&d, Some(&pos.path), Some(LspFeature::Hover)).await?;
    Ok(Json(pool.hover(&pos, req.owner_only.unwrap_or(false)).await?).into_response())
}

async fn references(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let pos = position(&raw)?;
    let pool = pool_for(&d, Some(&pos.path), Some(LspFeature::References)).await?;
    Ok(Json(pool.references(&pos).await?).into_response())
}

async fn occurrences(State(d): State<Arc<ApiDeps>>, raw: Bytes) -> ApiResult {
    let pos = position(&raw)?;
    let pool = pool_for(&d, Some(&pos.path), None).await?;
    Ok(Json(pool.occurrences(&pos).await?).into_response())
}

async fn symbols(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: SymbolsQuery = query(raw.as_deref())?;
    if q.path.is_none() && q.q.is_none() {
        return Err(ApiError::bad_request("path or q required"));
    }
    let path = q.path.as_ref().map(|p| p.to_string());
    let feature = if path.is_some() { LspFeature::DocumentSymbol } else { LspFeature::WorkspaceSymbol };
    let pool = pool_for(&d, path.as_deref(), Some(feature)).await?;
    let answer = match &path {
        Some(path) => pool.document_symbols(path).await?,
        None => pool.workspace_symbols(q.q.as_deref().unwrap_or_default()).await?,
    };
    Ok(Json(answer).into_response())
}

async fn graph(State(d): State<Arc<ApiDeps>>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: GraphQuery = query(raw.as_deref())?;
    let cap = q.all.is_none().then_some(crate::graph::MAX_NODES);
    let pool = pool_for(&d, None, Some(LspFeature::References)).await?;
    let snapshotter = d.session.snapshotter()?;
    let snap = snapshotter.current().await?;
    Ok(Json(crate::graph::build(&pool, &snapshotter, &snap, cap, q.scope.as_deref().map(String::as_str)).await?)
        .into_response())
}
