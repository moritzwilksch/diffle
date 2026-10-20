//! Symbol navigation. Language servers arrive in a later phase; until then the API says they are off,
//! after validating each request as it will be.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};

use super::{ApiDeps, ApiError, ApiResult, body, query};
use crate::protocol::{LspLogQuery, LspPosition, LspStatus, SymbolsQuery};

/// The largest integer a JavaScript client can send exactly; zod's `.int()` refuses anything past it.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/lsp/status", get(status))
        .route("/api/lsp/log", get(log))
        .route("/api/lsp/definition", post(position))
        .route("/api/lsp/type-definition", post(position))
        .route("/api/lsp/hover", post(position))
        .route("/api/lsp/references", post(position))
        .route("/api/lsp/occurrences", post(position))
        .route("/api/lsp/symbols", get(symbols))
}

fn off() -> ApiError {
    ApiError(StatusCode::CONFLICT, "language servers are off".into())
}

async fn status() -> Response {
    Json(LspStatus { enabled: false, servers: Vec::new(), missing: Vec::new() }).into_response()
}

async fn log(RawQuery(raw): RawQuery) -> ApiResult {
    let _: LspLogQuery = query(raw.as_deref())?;
    Err(ApiError::not_found("no such language server"))
}

async fn position(raw: Bytes) -> ApiResult {
    let pos: LspPosition = body(&raw)?;
    if pos.col < 0 || pos.col as u64 > MAX_SAFE_INTEGER || pos.line.get() > MAX_SAFE_INTEGER {
        return Err(ApiError::bad_request("line and col: expected safe non-negative integers, line from 1"));
    }
    Err(off())
}

async fn symbols(RawQuery(raw): RawQuery) -> ApiResult {
    let q: SymbolsQuery = query(raw.as_deref())?;
    if q.path.is_none() && q.q.is_none() {
        return Err(ApiError::bad_request("path or q required"));
    }
    Err(off())
}
