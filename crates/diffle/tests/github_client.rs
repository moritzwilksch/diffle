//! The real GitHub client against a local stand-in: tokens, endpoints, status mapping, proxies.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::routing::any;
use diffle::github::client::{GithubClient, HttpClient, no_token, resolve_token_with};
use serde_json::{Value, json};

fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
    let map: HashMap<String, String> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    move |name| map.get(name).cloned()
}

/// A `gh` that records the hosts it was asked about and answers `token`.
fn gh(
    asked: &Arc<Mutex<Vec<String>>>,
    token: Option<&str>,
) -> impl FnOnce(String) -> std::future::Ready<Option<String>> {
    let (asked, token) = (asked.clone(), token.map(str::to_owned));
    move |host| {
        asked.lock().unwrap().push(host);
        std::future::ready(token)
    }
}

fn found(token: &str, source: &str) -> Option<(String, String)> {
    Some((token.to_owned(), source.to_owned()))
}

#[tokio::test]
async fn prefers_github_token_then_gh_token_then_what_gh_holds_for_github_com() {
    let asked = Arc::default();
    let both = env(&[("GITHUB_TOKEN", "a"), ("GH_TOKEN", "b")]);
    assert_eq!(resolve_token_with("github.com", both, gh(&asked, Some("from-gh"))).await, found("a", "GITHUB_TOKEN"));
    let blank = env(&[("GITHUB_TOKEN", " "), ("GH_TOKEN", " b ")]);
    assert_eq!(resolve_token_with("github.com", blank, gh(&asked, Some("from-gh"))).await, found("b", "GH_TOKEN"));
    let none = env(&[]);
    assert_eq!(
        resolve_token_with("github.com", none, gh(&asked, Some("from-gh"))).await,
        found("from-gh", "gh auth token")
    );
    assert_eq!(*asked.lock().unwrap(), ["github.com"]);
}

#[tokio::test]
async fn reads_the_enterprise_variables_for_a_github_enterprise_server_as_gh_does() {
    let vars = [("GITHUB_TOKEN", "cloud"), ("GH_ENTERPRISE_TOKEN", "server")];
    let asked = Arc::default();
    assert_eq!(
        resolve_token_with("github.work.com", env(&vars), gh(&asked, None)).await,
        found("server", "GH_ENTERPRISE_TOKEN")
    );
    assert_eq!(resolve_token_with("acme.ghe.com", env(&vars), gh(&asked, None)).await, found("cloud", "GITHUB_TOKEN"));
    let asked = Arc::default();
    resolve_token_with("github.work.com", env(&[("GITHUB_TOKEN", "cloud")]), gh(&asked, None)).await;
    assert_eq!(*asked.lock().unwrap(), ["github.work.com"]);
}

#[tokio::test]
async fn is_none_when_nothing_has_a_token() {
    assert_eq!(resolve_token_with("github.com", env(&[]), gh(&Arc::default(), None)).await, None);
}

#[test]
fn says_where_to_put_a_token_for_the_host_that_lacks_one() {
    assert_eq!(
        no_token("github.com"),
        "No GitHub token for github.com: set GITHUB_TOKEN or sign in with gh auth login"
    );
    assert_eq!(
        no_token("github.work.com"),
        "No GitHub token for github.work.com: set GITHUB_ENTERPRISE_TOKEN or sign in with gh auth login --hostname github.work.com"
    );
}

/// One recorded request: its path, headers and JSON body.
#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

/// A GitHub on localhost answering every request with `status` and `body` (after `delay`), recording it.
async fn server(status: u16, body: Value, delay: Duration) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let record = seen.clone();
    let app = Router::new().fallback(any(move |uri: Uri, headers: HeaderMap, raw: Bytes| {
        let (record, body) = (record.clone(), body.clone());
        async move {
            let headers =
                headers.iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_owned())).collect();
            let sent = serde_json::from_slice(&raw).unwrap_or(Value::Null);
            record.lock().unwrap().push(Seen { path: uri.path().to_owned(), headers, body: sent });
            tokio::time::sleep(delay).await;
            (StatusCode::from_u16(status).unwrap(), axum::Json(body))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

fn client(base: &str) -> HttpClient {
    HttpClient::with_env("tok".into(), base, |_| None).unwrap()
}

#[tokio::test]
async fn posts_the_document_and_variables_with_the_token_to_the_graphql_endpoint_of_the_base_url() {
    let (base, seen) = server(200, json!({ "data": { "viewer": { "login": "me" } } }), Duration::ZERO).await;
    let data =
        client(&format!("{base}/api/v3")).graphql("query{viewer{login}}", json!({ "n": 1 }), None).await.unwrap();
    assert_eq!(data, json!({ "viewer": { "login": "me" } }));
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    // GitHub Enterprise Server keeps GraphQL beside, not under, the REST root.
    assert_eq!(seen[0].path, "/api/graphql");
    assert_eq!(seen[0].headers["authorization"], "token tok");
    assert!(seen[0].headers["user-agent"].starts_with("diffle/"));
    assert_eq!(seen[0].body, json!({ "query": "query{viewer{login}}", "variables": { "n": 1 } }));
}

#[tokio::test]
async fn turns_a_missing_pull_request_into_a_409_with_githubs_own_message() {
    let body = json!({
        "data": { "repository": { "pullRequest": null } },
        "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve to a PullRequest with the number of 999." }],
    });
    let (base, _) = server(200, body, Duration::ZERO).await;
    let err = client(&base).graphql("query{x}", json!({}), None).await.unwrap_err();
    assert_eq!(
        (err.status, err.message.as_str()),
        (409, "GitHub: Could not resolve to a PullRequest with the number of 999.")
    );
}

#[tokio::test]
async fn turns_a_rejected_token_into_a_409_that_says_so() {
    let (base, _) = server(401, json!({ "message": "Bad credentials" }), Duration::ZERO).await;
    let err = client(&base).graphql("query{x}", json!({}), None).await.unwrap_err();
    assert_eq!(err.status, 409);
    assert!(err.message.contains("rejected the token (401): Bad credentials"), "{err}");
}

#[tokio::test]
async fn turns_any_other_graphql_error_and_a_failing_server_into_502() {
    let refused = json!({ "errors": [{ "type": "UNPROCESSABLE", "message": "Line could not be resolved" }] });
    let (base, _) = server(200, refused, Duration::ZERO).await;
    let err = client(&base).graphql("mutation{x}", json!({}), None).await.unwrap_err();
    assert_eq!((err.status, err.message.as_str()), (502, "GitHub: Line could not be resolved"));
    let (base, _) = server(503, json!({ "message": "unavailable" }), Duration::ZERO).await;
    let err = client(&base).graphql("query{x}", json!({}), None).await.unwrap_err();
    assert_eq!(err.status, 502);
    assert!(err.message.contains("GitHub 503"), "{err}");
    // Nothing listens on a port just let go.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let err = client(&format!("http://{closed}")).graphql("query{x}", json!({}), None).await.unwrap_err();
    assert_eq!(err.status, 502);
    assert!(err.message.starts_with("cannot reach GitHub: "), "{err}");
}

#[tokio::test]
async fn gives_up_on_a_slow_github_after_the_timeout() {
    let (base, _) = server(200, json!({ "data": {} }), Duration::from_secs(5)).await;
    let err = client(&base).graphql("query{x}", json!({}), Some(Duration::from_millis(20))).await.unwrap_err();
    assert_eq!((err.status, err.message.as_str()), (502, "GitHub did not answer within 20ms"));
}

#[tokio::test]
async fn sends_github_requests_through_the_proxy_the_environment_names() {
    let (proxy, seen) = server(502, json!({}), Duration::ZERO).await;
    let vars = env(&[("HTTP_PROXY", &proxy)]);
    let client = HttpClient::with_env("t".into(), "http://github.invalid/api/v3", vars).unwrap();
    assert!(client.graphql("{ viewer { login } }", json!({}), None).await.is_err());
    // A plain HTTP request goes to the proxy in absolute form.
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].headers["host"], "github.invalid");
    assert_eq!(seen[0].path, "/api/graphql");
    // NO_PROXY exempts a host: the request then fails on its own, the proxy never sees it.
    let exempt = env(&[("http_proxy", &proxy), ("no_proxy", "github.invalid")]);
    let direct = HttpClient::with_env("t".into(), "http://github.invalid/api/v3", exempt).unwrap();
    assert!(direct.graphql("{ viewer { login } }", json!({}), None).await.is_err());
}

#[test]
fn turns_a_malformed_proxy_url_into_a_github_error() {
    let err =
        HttpClient::with_env("t".into(), "https://api.github.com", env(&[("HTTPS_PROXY", "not a url")])).err().unwrap();
    assert_eq!(err.status, 400);
    assert!(err.message.starts_with("invalid proxy environment: "), "{err}");
}
