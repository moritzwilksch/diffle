//! Reports: listing, pushing, deleting, and the files and logs behind them.
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, put};
use serde_json::json;

use super::{ApiDeps, ApiError, ApiResult, body, query};
use crate::protocol::{ReportFileQuery, ReportInput, ReportLogResponse};
use crate::reports::same_target;

pub fn routes() -> Router<Arc<ApiDeps>> {
    Router::new()
        .route("/api/reports", get(list))
        .route("/api/reports/{id}", get(one).put(put_report).delete(remove))
        .route("/api/reports/{id}/files/{*path}", put(upload))
        .route("/api/reports/{id}/file", get(file))
        .route("/api/reports/{id}/log", get(log))
}

async fn list(State(d): State<Arc<ApiDeps>>) -> ApiResult {
    Ok(Json(d.reports.list().await?).into_response())
}

async fn one(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(d.reports.get(&id).await?).into_response())
}

/// Creates (201) or replaces (200) a pushed report. A `target` that is not the current snapshot's
/// answers 409 with the current one, so the caller can refetch what it describes.
async fn put_report(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, raw: Bytes) -> ApiResult {
    let req: ReportInput = body(&raw)?;
    if let Some(target) = &req.target {
        let current = d.reports.current_target().await?;
        if !same_target(target, &current) {
            let error = "target: the snapshot moved on; fetch the review again and name the current target";
            return Ok((StatusCode::CONFLICT, Json(json!({ "error": error, "current": current }))).into_response());
        }
    }
    let (report, created) = d.reports.put(&id, req).await?;
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    Ok((status, Json(report)).into_response())
}

async fn remove(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>) -> ApiResult {
    d.reports.delete(&id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// A file the next put of report `id` may name as `path`: raw bytes, a raster image.
async fn upload(State(d): State<Arc<ApiDeps>>, Path((id, path)): Path<(String, String)>, raw: Bytes) -> ApiResult {
    let file = d.reports.upload(&id, &path, &raw).await?;
    Ok((StatusCode::CREATED, Json(file)).into_response())
}

async fn file(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>, RawQuery(raw): RawQuery) -> ApiResult {
    let q: ReportFileQuery = query(raw.as_deref())?;
    match d.reports.file(&id, &q.key).await? {
        Some((bytes, kind)) => {
            Ok(([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "private, max-age=31536000, immutable")], bytes)
                .into_response())
        }
        None => Err(ApiError::not_found("no such file in the report")),
    }
}

async fn log(State(d): State<Arc<ApiDeps>>, Path(id): Path<String>) -> ApiResult {
    Ok(Json(ReportLogResponse { lines: d.reports.log(&id)? }).into_response())
}
