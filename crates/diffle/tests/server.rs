mod common;

use std::time::Duration;

use common::server::TestServer;
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const BODY_ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/review"),
    ("POST", "/api/patch"),
    ("POST", "/api/threads"),
    ("POST", "/api/threads/missing/replies"),
    ("PATCH", "/api/threads/missing/messages/missing"),
    ("PUT", "/api/threads/missing/resolved"),
    ("PUT", "/api/viewed"),
    ("PUT", "/api/viewed/bulk"),
    ("PUT", "/api/config"),
    ("POST", "/api/github/export"),
    ("POST", "/api/lsp/definition"),
    ("POST", "/api/lsp/type-definition"),
    ("POST", "/api/lsp/hover"),
    ("POST", "/api/lsp/references"),
    ("POST", "/api/lsp/occurrences"),
];

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(s: &TestServer, headers: &[(&str, &str)]) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
    let mut req = s.ws_url().into_client_request().unwrap();
    for (name, value) in headers {
        let name = tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes()).unwrap();
        req.headers_mut().insert(name, value.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws)
}

/// Waits for the hub to count `n` clients: a client's close is not the server's.
async fn clients(s: &TestServer, n: usize) {
    let mut rx = s.hub.clients();
    tokio::time::timeout(Duration::from_secs(5), rx.wait_for(|c| *c == n)).await.unwrap().unwrap();
}

#[tokio::test]
async fn rejects_malformed_json_and_null_before_side_effects() {
    let s = TestServer::start().await;
    let mode = serde_json::to_value(s.session.review().unwrap()).unwrap();
    let before = serde_json::to_value(s.config.get()).unwrap();
    let mut ws = connect(&s, &[]).await.unwrap();
    for (method, path) in BODY_ROUTES {
        for body in ["{broken", "null", ""] {
            let r = s.send(method, path, &[], Some(body.into())).await;
            assert_eq!(r.status, 400, "{method} {path} {body:?}: {}", r.body);
            assert!(r.json()["error"].is_string());
        }
    }
    assert_eq!(serde_json::to_value(s.session.review().unwrap()).unwrap(), mode);
    assert_eq!(serde_json::to_value(s.config.get()).unwrap(), before);
    // Nothing was broadcast.
    assert!(tokio::time::timeout(Duration::from_millis(200), ws.next()).await.is_err());
    s.close().await;
}

#[tokio::test]
async fn validates_fields() {
    let s = TestServer::start().await;
    let cases: Vec<(&str, &str, Value)> = vec![
        ("POST", "/api/review", json!({ "kind": "revspec", "args": [1] })),
        ("POST", "/api/patch", json!({ "paths": vec!["a.txt"; 201] })),
        ("PUT", "/api/config", json!({ "autoViewed": ["a", 1] })),
        ("PUT", "/api/config", json!({ "contextLines": -1 })),
        ("PUT", "/api/config", json!({ "contextLines": 1.5 })),
        ("PUT", "/api/config", json!({ "contextLines": 10001 })),
        ("PUT", "/api/viewed/bulk", json!({ "entries": [{ "path": "a", "blob": "", "viewed": true }, null] })),
        ("PUT", "/api/viewed", json!({ "path": "a", "blob": "", "viewed": "true" })),
        ("POST", "/api/github/export", json!({ "threadIds": [1] })),
        ("POST", "/api/threads/missing/replies", json!({ "body": "  " })),
        ("PATCH", "/api/threads/missing/messages/missing", json!({ "body": 1 })),
        ("PUT", "/api/threads/missing/resolved", json!({ "resolved": "false" })),
        ("POST", "/api/lsp/definition", json!({ "path": "a.ts", "line": 1.5, "col": 0 })),
        ("POST", "/api/lsp/definition", json!({ "path": "a.ts", "line": 0, "col": 0 })),
        ("POST", "/api/lsp/definition", json!({ "path": "a.ts", "line": 9007199254740992u64, "col": 0 })),
    ];
    for (method, path, body) in cases {
        let r = s.json(method, path, body.clone()).await;
        assert_eq!(r.status, 400, "{method} {path} {body}: {}", r.body);
    }
    s.close().await;
}

#[tokio::test]
async fn validates_query_parameters() {
    let s = TestServer::start().await;
    for path in [
        "/api/file?path=a.txt&rev=other",
        "/api/search?scope=other",
        "/api/search?content=other",
        "/api/search?word=true",
        "/api/threads?state=other",
        "/api/threads/export?state=other",
        "/api/lsp/symbols",
    ] {
        assert_eq!(s.get(path).await.status, 400, "{path}");
    }
    s.close().await;
}

#[tokio::test]
async fn does_not_clear_threads_for_an_invalid_stale_filter() {
    let s = TestServer::start().await;
    let created = s.json("POST", "/api/threads", json!({ "path": "a.txt", "body": "keep" })).await;
    assert_eq!(created.status, 201);
    assert_eq!(s.send("DELETE", "/api/threads?stale=0", &[], None).await.status, 400);
    assert_eq!(s.get("/api/threads").await.json().as_array().unwrap().len(), 1);
    s.close().await;
}

#[tokio::test]
async fn serves_repository_identity_as_github_metadata() {
    let s = TestServer::start().await;
    let version = s.get("/api/snapshot").await.json()["version"].clone();
    let r = s.get("/api/github").await;
    assert_eq!(r.status, 200, "{}", r.body);
    let metadata = r.json();
    assert_eq!(
        (&metadata["version"], &metadata["repository"], &metadata["pullRequest"]),
        (&version, &json!(null), &json!(null))
    );
    assert!(metadata["reason"].is_string(), "{metadata}");
    s.close().await;
}

#[tokio::test]
async fn validates_preview_counts_and_returns_the_available_endpoint_messages() {
    let s = TestServer::start().await;
    for count in ["", "-1", "1.5", "nope", "9007199254740992"] {
        let r = s.get(&format!("/api/last-commits-preview?newOffset=0&oldOffset={count}")).await;
        assert_eq!(r.status, 400, "{count:?}");
    }
    let r = s.get("/api/last-commits-preview?oldOffset=1&newOffset=0").await;
    assert_eq!(r.status, 200);
    let preview = r.json();
    assert_eq!(preview["old"], Value::Null);
    assert_eq!(preview["new"]["message"], "base");
    s.close().await;
}

#[tokio::test]
async fn reports_no_moved_refs_for_a_worktree_comparison_and_recomputes_the_snapshot_on_reload() {
    let s = TestServer::start().await;
    assert_eq!(s.get("/api/moved").await.json(), Value::Null);
    let before = s.get("/api/snapshot").await.json();
    let r = s.send("POST", "/api/reload", &[], None).await;
    assert_eq!(r.status, 200);
    let snap = r.json();
    assert!(snap["version"].as_i64() > before["version"].as_i64());
    assert_eq!(snap["review"], before["review"]);
    s.close().await;
}

#[tokio::test]
async fn answers_delete_iterations() {
    let s = TestServer::start().await;
    assert_eq!(s.send("DELETE", "/api/iterations", &[], None).await.status, 200);
    s.close().await;
}

#[tokio::test]
async fn refuses_delete_iterations_n_for_an_iteration_it_does_not_have_or_a_number_it_cannot_read() {
    let s = TestServer::start().await;
    for path in ["/api/iterations/1", "/api/iterations/x", "/api/iterations/0"] {
        let r = s.send("DELETE", path, &[], None).await;
        assert_eq!(r.status, 400, "{path}");
        assert!(r.json()["error"].as_str().unwrap().contains("iteration"), "{}", r.body);
    }
    s.close().await;
}

#[tokio::test]
async fn returns_a_json_error_for_unknown_api_routes_instead_of_the_app_page() {
    let s = TestServer::start().await;
    let r = s.get("/api/unknown-endpoint").await;
    assert_eq!(r.status, 404);
    assert!(r.json()["error"].as_str().unwrap().contains("API endpoint not found"));
    s.close().await;
}

#[tokio::test]
async fn creates_a_thread_on_the_whole_file_from_a_payload_without_a_line_and_exports_it_without_a_quote() {
    let s = TestServer::start().await;
    let created = s.json("POST", "/api/threads", json!({ "path": "a.txt", "body": "Rename it." })).await;
    assert_eq!(created.status, 201);
    let thread = &created.json()[0];
    assert_eq!(thread["anchor"], json!({ "kind": "file", "path": "a.txt" }));
    assert_eq!(thread["stale"], false);
    let r = s.get("/api/threads/export").await;
    assert_eq!((r.status, r.body.as_str()), (200, "(file) a.txt\n\nRename it.\n\n---\n"));
    let missing = s.json("POST", "/api/threads", json!({ "path": "nope.txt", "body": "x" })).await;
    assert_eq!(missing.status, 400);
    assert!(missing.json()["error"].as_str().unwrap().contains("nope.txt"));
    s.close().await;
}

#[tokio::test]
async fn exports_one_message_with_its_thread_context() {
    let s = TestServer::start().await;
    let created =
        s.json("POST", "/api/threads", json!({ "path": "a.txt", "startLine": 1, "body": "Check this." })).await;
    let thread = &created.json()[0];
    let (id, mid) = (thread["id"].as_str().unwrap(), thread["messages"][0]["id"].as_str().unwrap());
    let r = s.get(&format!("/api/threads/{id}/messages/{mid}/export")).await;
    assert_eq!((r.status, r.body.as_str()), (200, "a.txt:1\n\n> a\n\nCheck this.\n\n---\n"));
    assert_eq!(s.get(&format!("/api/threads/{id}/messages/missing/export")).await.status, 404);
    s.close().await;
}

#[tokio::test]
async fn rejects_foreign_host_and_mismatched_origin_with_a_403_naming_the_header() {
    let s = TestServer::start().await;
    let host = s.send("GET", "/api/snapshot", &[("host", "evil.example")], None).await;
    assert_eq!(host.status, 403);
    assert!(host.json()["error"].as_str().unwrap().starts_with("forbidden Host "));
    let origin = s.send("GET", "/api/snapshot", &[("origin", "http://evil.example")], None).await;
    assert_eq!(origin.status, 403);
    assert!(origin.json()["error"].as_str().unwrap().starts_with("forbidden Origin "));
    let own = format!("http://{}", s.host());
    assert_eq!(s.send("GET", "/api/snapshot", &[("origin", &own)], None).await.status, 200);
    s.close().await;
}

#[tokio::test]
async fn answers_a_rejected_websocket_upgrade_with_a_403_naming_the_header() {
    let s = TestServer::start().await;
    let Err(err) = connect(&s, &[("origin", "https://evil.example")]).await else { panic!("upgrade accepted") };
    match err {
        tokio_tungstenite::tungstenite::Error::Http(res) => {
            assert_eq!(res.status(), 403);
            let body = String::from_utf8(res.body().clone().unwrap_or_default()).unwrap();
            assert!(body.starts_with("forbidden Origin "), "{body}");
        }
        other => panic!("expected an HTTP refusal, got {other}"),
    }
    s.close().await;
}

#[tokio::test]
async fn accepts_proxied_http_and_websockets() {
    let s = TestServer::start().await;
    for host in ["proxy.example", "127.0.0.1:4966"] {
        let headers = [("host", host), ("origin", "https://proxy.example")];
        assert_eq!(s.send("GET", "/api/snapshot", &headers, None).await.status, 200, "{host}");
        let evil = [("host", host), ("origin", "https://evil.example")];
        assert_eq!(s.send("GET", "/api/snapshot", &evil, None).await.status, 403, "{host}");
        let mut ws = connect(&s, &headers).await.unwrap_or_else(|e| panic!("{host}: {e}"));
        clients(&s, 1).await;
        ws.close(None).await.unwrap();
        clients(&s, 0).await;
    }
    s.close().await;
}

#[tokio::test]
async fn reports_websocket_clients_joining_and_leaving() {
    let s = TestServer::start().await;
    let mut ws = connect(&s, &[]).await.unwrap();
    clients(&s, 1).await;
    assert_eq!(s.hub.client_count(), 1);
    ws.close(None).await.unwrap();
    clients(&s, 0).await;
    s.close().await;
}

#[tokio::test]
async fn survives_a_malformed_websocket_frame_and_keeps_serving() {
    let s = TestServer::start().await;
    let mut sock = tokio::net::TcpStream::connect(s.host()).await.unwrap();
    let upgrade = format!(
        "GET /ws HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        s.host()
    );
    sock.write_all(upgrade.as_bytes()).await.unwrap();
    let mut buf = [0u8; 1024];
    let n = sock.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 101"));
    clients(&s, 1).await;
    // A whole frame header of garbage (reserved bits and opcode set): tungstenite reads the full
    // header, extended length and mask included, before it judges one.
    sock.write_all(&[0xff; 16]).await.unwrap();
    // The server drops the client rather than the process.
    let mut rest = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), sock.read_to_end(&mut rest)).await.unwrap().ok();
    clients(&s, 0).await;
    assert_eq!(s.get("/api/snapshot").await.status, 200);
    s.close().await;
}

#[tokio::test]
async fn post_patch_returns_the_listed_files_skipping_unknown_ones_and_rejects_a_malformed_body() {
    let s = TestServer::start().await;
    s.repo.write("a.txt", "a\nb\n");
    s.repo.write("n.txt", "n\n");
    s.session.refresh().await;
    let r = s.json("POST", "/api/patch", json!({ "paths": ["a.txt", "n.txt", "missing.txt"] })).await;
    assert_eq!(r.status, 200);
    assert!(r.body.contains("+++ b/a.txt") && r.body.contains("+++ b/n.txt"), "{}", r.body);
    assert!(!r.body.contains("missing.txt"));
    let one = s.json("POST", "/api/patch", json!({ "paths": ["n.txt"] })).await;
    assert!(one.body.contains("+++ b/n.txt") && !one.body.contains("a.txt"));
    assert_eq!(s.json("POST", "/api/patch", json!({ "paths": "a.txt" })).await.status, 400);
    s.close().await;
}

async fn search_paths(s: &TestServer, qs: &str) -> Vec<String> {
    let r = s.get(&format!("/api/search?{qs}")).await;
    assert_eq!(r.status, 200, "{qs}: {}", r.body);
    r.json()["matches"].as_array().unwrap().iter().map(|m| m["path"].as_str().unwrap().to_owned()).collect()
}

#[tokio::test]
async fn get_search_covers_changed_files_or_one_file_with_full_contents_requested_explicitly() {
    let s = TestServer::start().await;
    s.repo.write("n.txt", "needle\n");
    // n.txt is committed, so it is in the tree but not in the working diff.
    s.repo.git(&["add", "n.txt"]);
    s.repo.git(&["commit", "-q", "-m", "unchanged file"]);
    s.repo.write("a.txt", "a\nneedle\n");
    s.session.refresh().await;
    assert_eq!(search_paths(&s, "q=needle").await, ["a.txt"]);
    assert_eq!(search_paths(&s, "q=needle&scope=diff").await, ["a.txt"]);
    assert_eq!(search_paths(&s, "q=needle&scope=repo&content=full").await, ["a.txt", "n.txt"]);
    assert_eq!(search_paths(&s, "q=needle&scope=file&content=full&path=n.txt").await, ["n.txt"]);
    // A file outside the new side matches nothing rather than widening to everything.
    assert!(search_paths(&s, "q=needle&scope=file&path=missing.txt").await.is_empty());
    assert!(search_paths(&s, "q=needle&scope=file").await.is_empty());
    s.close().await;
}

#[tokio::test]
async fn searches_diff_hunks_with_context_or_full_changed_files_independently_of_file_scope() {
    let s = TestServer::start().await;
    s.repo.write("n.txt", "needle\n");
    let original: String = (1..=620).map(|i| format!("needle {i}\n")).collect();
    s.repo.write("context.txt", &original);
    s.repo.commit("search context fixture");
    s.repo.write("context.txt", original.replace("needle 610\n", "needle changed\n"));
    s.session.refresh().await;
    let search = async |options: &str| {
        let r = s.get(&format!("/api/search?q=needle&{options}")).await;
        assert_eq!(r.status, 200);
        r.json()
    };
    for scope in ["scope=diff", "scope=file&path=context.txt"] {
        let visible = search(&format!("{scope}&content=diff")).await;
        let lines: Vec<i64> =
            visible["matches"].as_array().unwrap().iter().map(|m| m["line"].as_i64().unwrap()).collect();
        assert_eq!(lines, [607, 608, 609, 610, 611, 612, 613], "{scope}");
        assert_eq!(visible["truncated"], false);
        let full = search(&format!("{scope}&content=full")).await;
        let matches = full["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 500);
        assert!(matches.iter().all(|m| m["path"] == "context.txt"));
        assert_eq!(matches[0]["line"], 1);
        assert_eq!(full["truncated"], true);
    }
    assert!(search("scope=file&path=n.txt&content=diff").await["matches"].as_array().unwrap().is_empty());
    assert_eq!(search("scope=file&path=n.txt&content=full").await["matches"].as_array().unwrap().len(), 1);
    s.close().await;
}

#[tokio::test]
async fn rejects_oversized_bodies_with_413() {
    let s = TestServer::start().await;
    let before = serde_json::to_value(s.config.get()).unwrap();
    let body = json!({ "autoViewed": ["x".repeat(2 * 1024 * 1024)] }).to_string();
    let len = body.len().to_string();
    let sized = s.send("PUT", "/api/config", &[("content-length", &len)], Some(body.clone())).await;
    // A streamed body goes out chunked.
    let stream = futures::stream::iter(
        body.into_bytes().chunks(64 * 1024).map(|c| Ok::<_, std::io::Error>(c.to_vec())).collect::<Vec<_>>(),
    );
    let chunked = reqwest::Client::new()
        .put(format!("{}api/config", s.base))
        .header("content-type", "application/json")
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .unwrap();
    let chunked = (chunked.status().as_u16(), chunked.text().await.unwrap());
    for (status, text) in [(sized.status, sized.body), chunked] {
        assert_eq!(status, 413);
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({ "error": "request body too large" }));
    }
    assert_eq!(serde_json::to_value(s.config.get()).unwrap(), before);
    assert_eq!(s.get("/api/snapshot").await.status, 200);
    s.close().await;
}

// GET /api/file serving a file outside the snapshot after a language server named it: tests/server_lsp.rs.
#[tokio::test]
async fn lsp_routes_say_language_servers_are_off() {
    let s = TestServer::start().await;
    assert_eq!(s.get("/api/lsp/status").await.json(), json!({ "enabled": false, "servers": [], "missing": [] }));
    let r = s.json("POST", "/api/lsp/definition", json!({ "path": "a.txt", "line": 1, "col": 0 })).await;
    assert_eq!((r.status, r.json()), (409, json!({ "error": "Language servers are off for this run (--no-lsp)" })));
    assert_eq!(s.get("/api/lsp/log?server=fake").await.status, 404);
    s.close().await;
}

#[tokio::test]
async fn ignores_lsp_commands_on_put_config() {
    let s = TestServer::start().await;
    let before = s.config.get().lsp_commands;
    let r = s.json("PUT", "/api/config", json!({ "lspCommands": { "python": "rm -rf /" }, "contextLines": 7 })).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["lspCommands"], serde_json::to_value(&before).unwrap());
    let after = s.config.get();
    assert_eq!((after.lsp_commands, after.context_lines), (before, 7));
    s.close().await;
}

// Windows has no POSIX mode bits to check.
#[cfg(unix)]
#[tokio::test]
async fn writes_the_config_file_and_its_directory_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let s = TestServer::start().await;
    s.json("PUT", "/api/config", json!({ "contextLines": 7 })).await;
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(s.config.file()), 0o600);
    assert_eq!(mode(&s.repo.path.join("cfg")), 0o700);
    s.close().await;
}
