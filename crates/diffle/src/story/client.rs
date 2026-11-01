//! The model that writes stories: the one HTTP call to the Anthropic Messages API, behind a trait
//! tests answer directly.
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Value, json};

use crate::error::StoryError;

/// The default model; `DIFFLE_STORY_MODEL` names another.
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2026-10-21";
/// `fallbacks: "default"` reruns a refused request on the model Anthropic recommends for the refusal's category.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// A story is a few thousand tokens; the cap guards against a runaway answer, not a long one.
const MAX_TOKENS: u32 = 16_000;
/// A large diff takes the model a while to read; the request is retried by nobody, so it may take its time.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

/// What the model is asked: the instructions, the review, and the shape its answer must take.
#[derive(Debug)]
pub struct ModelRequest {
    pub system: String,
    pub user: String,
    /// A JSON Schema the answer is constrained to.
    pub schema: Value,
}

/// The answer, parsed, and the model that gave it (a fallback may differ from the one asked).
#[derive(Debug)]
pub struct ModelAnswer {
    pub json: Value,
    pub model: String,
}

/// The transport the service knows: one request, one schema-shaped answer.
pub trait StoryModel: Send + Sync {
    fn complete(&self, req: ModelRequest) -> BoxFuture<'_, Result<ModelAnswer, StoryError>>;
}

/// Said wherever a story is asked for without a key.
pub fn no_key() -> String {
    "No Anthropic API key: set ANTHROPIC_API_KEY to write stories".to_owned()
}

/// The real model over reqwest, which honours `HTTPS_PROXY` and `NO_PROXY` as git does.
pub struct AnthropicClient {
    http: reqwest::Client,
    key: String,
    base_url: String,
    pub model: String,
}

impl AnthropicClient {
    /// From `ANTHROPIC_API_KEY`, with `ANTHROPIC_BASE_URL` and `DIFFLE_STORY_MODEL` as overrides; the
    /// error names what is missing.
    pub fn from_env(env: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let var = |name: &str| env(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let key = var("ANTHROPIC_API_KEY").ok_or_else(no_key)?;
        let base_url = var("ANTHROPIC_BASE_URL").unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let model = var("DIFFLE_STORY_MODEL").unwrap_or_else(|| DEFAULT_MODEL.to_owned());
        Self::new(key, base_url, model)
    }

    pub fn new(key: String, base_url: String, model: String) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("cannot build an HTTP client: {e}"))?;
        Ok(Self { http, key, base_url: base_url.trim_end_matches('/').to_owned(), model })
    }

    fn body(&self, req: &ModelRequest) -> Value {
        json!({
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "fallbacks": "default",
            "output_config": {
                "effort": "medium",
                "format": { "type": "json_schema", "schema": req.schema },
            },
            "system": [{ "type": "text", "text": req.system }],
            "messages": [{ "role": "user", "content": [{ "type": "text", "text": req.user }] }],
        })
    }
}

impl StoryModel for AnthropicClient {
    fn complete(&self, req: ModelRequest) -> BoxFuture<'_, Result<ModelAnswer, StoryError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(format!("{}/v1/messages", self.base_url))
                .header("x-api-key", &self.key)
                .header("anthropic-version", API_VERSION)
                .header("anthropic-beta", FALLBACK_BETA)
                .json(&self.body(&req))
                .send()
                .await
                .map_err(|e| StoryError::upstream(format!("Anthropic did not answer: {e}")))?;
            let status = response.status();
            let body: Value =
                response.json().await.map_err(|e| StoryError::upstream(format!("Anthropic answered no JSON: {e}")))?;
            if !status.is_success() {
                return Err(request_error(status.as_u16(), &body));
            }
            parse_answer(body)
        })
    }
}

/// A rejected key is the user's to fix; anything else is Anthropic's.
fn request_error(status: u16, body: &Value) -> StoryError {
    let detail =
        body.pointer("/error/message").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| body.to_string());
    match status {
        401 | 403 => StoryError::conflict(format!("Anthropic rejected the API key ({status}): {detail}")),
        _ => StoryError::upstream(format!("Anthropic answered {status}: {detail}")),
    }
}

/// The text blocks of a Messages API response as one JSON document, once the stop reason allows it.
pub fn parse_answer(body: Value) -> Result<ModelAnswer, StoryError> {
    match body.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => {
            let why = body.pointer("/stop_details/explanation").and_then(Value::as_str).unwrap_or("no reason given");
            return Err(StoryError::upstream(format!("The model declined to write the story: {why}")));
        }
        Some("max_tokens") => return Err(StoryError::upstream("The model's answer was cut short")),
        _ => {}
    }
    let text: String = body
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let json = serde_json::from_str(&text)
        .map_err(|e| StoryError::upstream(format!("The model's answer is not the JSON asked for: {e}")))?;
    let model = body.get("model").and_then(Value::as_str).unwrap_or("unknown").to_owned();
    Ok(ModelAnswer { json, model })
}
