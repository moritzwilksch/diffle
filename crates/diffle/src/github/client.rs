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

/// The real client: octocrab over reqwest, which reads `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`
/// (either case) as git does.
pub struct HttpClient {
    octocrab: octocrab::Octocrab,
}

impl HttpClient {
    /// A client for the REST root `base_url` (see `api_base_url`); GraphQL sits beside it.
    pub fn new(token: String, base_url: &str) -> Result<Self, GithubError> {
        let octocrab = octocrab::Octocrab::builder()
            .base_uri(graphql_root(base_url))
            .and_then(|b| b.personal_token(token).build_with_reqwest(octocrab::ReqwestClientConfig::Default))
            .map_err(|e| {
                GithubError::new(format!("cannot set up the GitHub client: {}", first_line(&e.to_string())), 400)
            })?;
        Ok(Self { octocrab })
    }
}

/// Where `/graphql` hangs: GitHub Enterprise Server's REST root ends in `/api/v3`, its GraphQL
/// endpoint is `/api/graphql`.
fn graphql_root(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    base.strip_suffix("/v3").filter(|root| root.ends_with("/api")).unwrap_or(base).to_owned()
}

impl GithubClient for HttpClient {
    fn graphql(
        &self,
        query: &str,
        variables: Value,
        timeout: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, GithubError>> {
        let body = json!({ "query": query, "variables": variables });
        Box::pin(async move {
            // The raw body: octocrab's own `graphql` drops the error `type` that tells 409 from 502.
            let request = self.octocrab.post::<_, Value>("/graphql", Some(&body));
            let answer = match timeout {
                Some(t) => tokio::time::timeout(t, request)
                    .await
                    .map_err(|_| GithubError::new(format!("GitHub did not answer within {}ms", t.as_millis()), 502))?,
                None => request.await,
            };
            graphql_result(answer.map_err(request_error)?)
        })
    }
}

/// A rejected token or a missing resource is the user's to fix (409); anything else is GitHub's (502).
fn request_error(e: octocrab::Error) -> GithubError {
    let octocrab::Error::GitHub { source, .. } = e else {
        return GithubError::new(format!("cannot reach GitHub: {}", first_line(&e.to_string())), 502);
    };
    let (status, detail) = (source.status_code.as_u16(), first_line(&source.message));
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
    fn reads_tokens_per_host_kind_and_derives_the_graphql_root() {
        assert_eq!(token_variables("acme.ghe.com"), ["GITHUB_TOKEN", "GH_TOKEN"]);
        assert_eq!(token_variables("git.corp"), ["GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"]);
        assert_eq!(
            no_token("git.corp"),
            "No GitHub token for git.corp: set GITHUB_ENTERPRISE_TOKEN or sign in with gh auth login --hostname git.corp"
        );
        assert_eq!(graphql_root("https://api.github.com"), "https://api.github.com");
        assert_eq!(graphql_root("https://git.corp/api/v3"), "https://git.corp/api");
        assert_eq!(graphql_root("https://api.acme.ghe.com/"), "https://api.acme.ghe.com");
    }

    #[test]
    fn tells_fixable_graphql_errors_from_refusals() {
        let not_found = json!({ "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve" }] });
        assert_eq!(graphql_result(not_found).unwrap_err().status, 409);
        let refused = json!({ "errors": [{ "type": "UNPROCESSABLE", "message": "a" }, { "message": "b" }] });
        let e = graphql_result(refused).unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (502, "GitHub: a; b"));
        assert_eq!(graphql_result(json!({ "data": { "x": 1 } })).unwrap(), json!({ "x": 1 }));
    }
}
