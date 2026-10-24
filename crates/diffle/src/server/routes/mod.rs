//! The HTTP API: shared request parsing and error mapping, and the route groups.
mod api;
mod comments;
mod files;
mod graph;
mod lsp;

use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::json;

use super::ApiDeps;
use crate::error::Error;

pub fn router() -> Router<Arc<ApiDeps>> {
    Router::new()
        .merge(api::routes())
        .merge(files::routes())
        .merge(comments::routes())
        .merge(graph::routes())
        .merge(lsp::routes())
}

/// An error as the API answers it: a status and `{ "error": message }`.
pub struct ApiError(pub StatusCode, pub String);

pub type ApiResult<T = Response> = Result<T, ApiError>;

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self(StatusCode::NOT_FOUND, message.into())
    }
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        match e {
            Error::NotFound(_) => Self::not_found("not found"),
            Error::Revspec(m) | Error::Invalid(m) | Error::Unquotable(m) => Self::bad_request(m),
            Error::Git(e) => Self::bad_request(e.message),
            Error::LspUnavailable(m) | Error::LspUnsupported(m) => Self(StatusCode::CONFLICT, m),
            Error::Github(e) => Self(StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_GATEWAY), e.message),
            Error::Other(e) => {
                crate::status!("[diffle] {e:#}");
                Self(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            }
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        Error::from(e).into()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, axum::Json(json!({ "error": self.1 }))).into_response()
    }
}

/// A JSON request body of shape `T`. Invalid JSON and the wrong shape are both the client's fault.
pub fn body<T: DeserializeOwned>(bytes: &[u8]) -> ApiResult<T> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ApiError::bad_request("invalid JSON body"))?;
    shaped(value)
}

/// `value` as `T`, or a 400 saying what did not fit.
pub fn shaped<T: DeserializeOwned>(value: serde_json::Value) -> ApiResult<T> {
    serde_json::from_value(value).map_err(|e| ApiError::bad_request(format!("invalid request: {e}")))
}

/// A query string of shape `T`.
pub fn query<T: DeserializeOwned>(raw: Option<&str>) -> ApiResult<T> {
    let pairs: Vec<(String, String)> = form_pairs(raw.unwrap_or_default());
    let map: serde_json::Map<String, serde_json::Value> =
        pairs.into_iter().map(|(k, v)| (k, serde_json::Value::String(v))).collect();
    serde_json::from_value(serde_json::Value::Object(map))
        .map_err(|e| ApiError::bad_request(format!("invalid query: {e}")))
}

/// `application/x-www-form-urlencoded` pairs; a repeated key keeps its last value.
fn form_pairs(raw: &str) -> Vec<(String, String)> {
    form_urlencoded::parse(raw.as_bytes()).into_owned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_form_pairs() {
        assert_eq!(
            form_pairs("path=a%20b%2Fc.txt&rev=new&q=x+y"),
            [("path".into(), "a b/c.txt".into()), ("rev".into(), "new".into()), ("q".into(), "x y".into())]
        );
        assert_eq!(
            form_pairs("q=%E2%9C%93&bad=%zz&end=%4"),
            [("q".into(), "✓".into()), ("bad".into(), "%zz".into()), ("end".into(), "%4".into())]
        );
    }
}
