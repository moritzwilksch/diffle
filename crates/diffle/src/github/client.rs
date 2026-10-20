//! Every GitHub request diffle makes: GraphQL over HTTPS, with a token from the environment or `gh`.
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Value, json};

use crate::error::GithubError;

/// The environment variables holding a token for `host`, in the order diffle reads them. gh's own
/// split: GitHub Enterprise Server tokens live apart from github.com and GHE.com ones.
pub fn token_variables(host: &str) -> [&'static str; 2] {
    if host == "github.com" || host.ends_with(".ghe.com") {
        ["GITHUB_TOKEN", "GH_TOKEN"]
    } else {
        ["GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"]
    }
}

/// Said wherever a GitHub feature is asked for without a token for `host`.
pub fn no_token(host: &str) -> String {
    let login =
        if host == "github.com" { "gh auth login".to_owned() } else { format!("gh auth login --hostname {host}") };
    format!("No GitHub token for {host}: set {} or sign in with {login}", token_variables(host)[0])
}

/// The token for `host` and where it came from: its environment variables, then the one `gh`
/// holds. None when neither has one: diffle then runs without GitHub.
pub async fn resolve_token(host: &str, env: impl Fn(&str) -> Option<String>) -> Option<(String, String)> {
    resolve_token_with(host, env, |host| async move { gh_auth_token(&host).await }).await
}

/// `resolve_token` with `gh` standing in for `gh auth token --hostname <host>`. Test seam.
pub async fn resolve_token_with<F: Future<Output = Option<String>>>(
    host: &str,
    env: impl Fn(&str) -> Option<String>,
    gh: impl FnOnce(String) -> F,
) -> Option<(String, String)> {
    for name in token_variables(host) {
        if let Some(token) = env(name).map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
            return Some((token, name.to_owned()));
        }
    }
    gh(host.to_owned()).await.map(|token| (token, "gh auth token".to_owned()))
}

/// The only `gh` left: its stored token for `host`, or none when gh is missing, signed out, or slow.
async fn gh_auth_token(host: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new("gh");
    cmd.args(["auth", "token", "--hostname", host]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (out.status.success() && !token.is_empty()).then_some(token)
}

/// The transport the rest of the server knows: one GraphQL request, answered by its `data` or a
/// `GithubError` carrying GitHub's own message. Tests answer queries by shape instead.
pub trait GithubClient: Send + Sync {
    fn graphql(
        &self,
        query: &str,
        variables: Value,
        timeout: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, GithubError>>;
}

/// The real client.
pub struct HttpClient {
    http: reqwest::Client,
    endpoint: String,
    token: String,
}

impl HttpClient {
    /// A client for the REST root `base_url` (see `api_base_url`); GraphQL sits beside it. Requests
    /// go through the proxy `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (either case) name, as git's do.
    pub fn new(token: String, base_url: &str) -> Result<Self, GithubError> {
        Self::with_env(token, base_url, |name| std::env::var(name).ok())
    }

    /// `new`, reading the proxy variables from `env`. A malformed proxy url is a 400.
    pub fn with_env(token: String, base_url: &str, env: impl Fn(&str) -> Option<String>) -> Result<Self, GithubError> {
        let var = |name: &str| env(name).or_else(|| env(&name.to_lowercase())).filter(|v| !v.trim().is_empty());
        let invalid = |e: reqwest::Error| GithubError::new(format!("invalid proxy environment: {e}"), 400);
        let no_proxy = var("NO_PROXY").and_then(|list| reqwest::NoProxy::from_string(&list));
        let mut builder = reqwest::Client::builder().user_agent(concat!("diffle/", env!("DIFFLE_VERSION"))).no_proxy();
        for (name, scheme) in [("HTTPS_PROXY", "https"), ("HTTP_PROXY", "http")] {
            let Some(url) = var(name) else { continue };
            let proxy = if scheme == "https" { reqwest::Proxy::https(&url) } else { reqwest::Proxy::http(&url) };
            builder = builder.proxy(proxy.map_err(invalid)?.no_proxy(no_proxy.clone()));
        }
        let http = builder.build().map_err(invalid)?;
        Ok(Self { http, endpoint: graphql_endpoint(base_url), token })
    }
}

/// GitHub Enterprise Server's REST root ends in `/api/v3`; its GraphQL endpoint is `/api/graphql`.
fn graphql_endpoint(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    match base.strip_suffix("/api/v3") {
        Some(root) => format!("{root}/api/graphql"),
        None => format!("{base}/graphql"),
    }
}

impl GithubClient for HttpClient {
    fn graphql(
        &self,
        query: &str,
        variables: Value,
        timeout: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, GithubError>> {
        // `token`, as Octokit sends it.
        let auth = format!("token {}", self.token);
        let mut request = self
            .http
            .post(&self.endpoint)
            .header(reqwest::header::AUTHORIZATION, auth)
            .json(&json!({ "query": query, "variables": variables }));
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        Box::pin(async move {
            let response = request.send().await.map_err(|e| unreachable(&e, timeout))?;
            let status = response.status();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(http_error(status.as_u16(), &body));
            }
            graphql_result(body)
        })
    }
}

fn unreachable(e: &reqwest::Error, timeout: Option<Duration>) -> GithubError {
    if e.is_timeout() {
        let ms = timeout.map_or_else(|| "?".to_owned(), |t| t.as_millis().to_string());
        return GithubError::new(format!("GitHub did not answer within {ms}ms"), 502);
    }
    GithubError::new(format!("cannot reach GitHub: {}", first_line(&e.to_string())), 502)
}

/// A rejected token or a missing resource is the user's to fix (409); anything else is GitHub's (502).
fn http_error(status: u16, body: &Value) -> GithubError {
    let detail = first_line(body.get("message").and_then(Value::as_str).unwrap_or("no message"));
    match status {
        401 => GithubError::conflict(format!("GitHub rejected the token (401): {detail}")),
        403 | 404 => GithubError::conflict(format!("GitHub {status}: {detail}")),
        _ => GithubError::new(format!("GitHub {status}: {detail}"), 502),
    }
}

/// `data`, unless GitHub listed errors. Errors that are all NOT_FOUND or FORBIDDEN are the user's to
/// fix (409); others mean GitHub refused the content (502).
pub fn graphql_result(body: Value) -> Result<Value, GithubError> {
    let errors = body.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty());
    if let Some(errors) = errors {
        let detail: Vec<&str> =
            errors.iter().map(|e| e.get("message").and_then(Value::as_str).unwrap_or("unknown error")).collect();
        let fixable =
            errors.iter().all(|e| matches!(e.get("type").and_then(Value::as_str), Some("NOT_FOUND" | "FORBIDDEN")));
        return Err(GithubError::new(format!("GitHub: {}", detail.join("; ")), if fixable { 409 } else { 502 }));
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

fn first_line(s: &str) -> &str {
    s.trim().lines().next().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tokens_per_host_kind_and_derives_the_graphql_endpoint() {
        assert_eq!(token_variables("acme.ghe.com"), ["GITHUB_TOKEN", "GH_TOKEN"]);
        assert_eq!(token_variables("git.corp"), ["GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"]);
        assert_eq!(
            no_token("git.corp"),
            "No GitHub token for git.corp: set GITHUB_ENTERPRISE_TOKEN or sign in with gh auth login --hostname git.corp"
        );
        assert_eq!(graphql_endpoint("https://api.github.com"), "https://api.github.com/graphql");
        assert_eq!(graphql_endpoint("https://git.corp/api/v3"), "https://git.corp/api/graphql");
        assert_eq!(graphql_endpoint("https://api.acme.ghe.com/"), "https://api.acme.ghe.com/graphql");
    }

    #[test]
    fn tells_fixable_graphql_errors_from_refusals() {
        let not_found = json!({ "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve" }] });
        assert_eq!(graphql_result(not_found).unwrap_err().status, 409);
        let refused = json!({ "errors": [{ "type": "UNPROCESSABLE", "message": "a" }, { "message": "b" }] });
        let e = graphql_result(refused).unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (502, "GitHub: a; b"));
        assert_eq!(graphql_result(json!({ "data": { "x": 1 } })).unwrap(), json!({ "x": 1 }));
        assert_eq!(
            http_error(401, &json!({ "message": "Bad credentials\nmore" })).message,
            "GitHub rejected the token (401): Bad credentials"
        );
        assert_eq!(http_error(500, &json!(null)).status, 502);
    }
}
