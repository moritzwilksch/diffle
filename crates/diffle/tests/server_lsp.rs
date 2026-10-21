//! The LSP routes over a real pool of fake language servers: what they answer, and why they refuse.
#![cfg(unix)]
mod common;

use std::collections::HashMap;

use serde_json::{Value, json};

use common::lsp::{eventually, fake_env, fake_servers, root};
use common::server::TestServer;
use common::{TestRepo, revspec};
use diffle::protocol::{EnterRequest, LanguageId};

/// `source.py` and `other.py` committed, a second commit on top, and `source.py` edited in the
/// worktree: the diff names python, so its server starts.
fn python_repo() -> TestRepo {
    let t = TestRepo::new();
    // The fake's environment lives in the root; keep it out of the review.
    std::fs::write(t.path.join(".git/info/exclude"), ".fake-env*\n").unwrap();
    t.write("source.py", "import sys\ndef f():\n    pass\n");
    t.write("other.py", "x = 1\ny = 2\nz = f()\n");
    t.write("notes.txt", "plain\n");
    t.commit("base");
    t.write("source.py", "import sys\ndef f():\n    return 1\n");
    t.commit("second");
    t.write("source.py", "import sys\ndef f():\n    pass\n");
    t
}

async fn serve(
    t: TestRepo,
    req: EnterRequest,
    env: &[(&str, &str)],
    overrides: &[(LanguageId, &str)],
) -> Option<TestServer> {
    fake_servers()?;
    let mut env = env.to_vec();
    if !env.iter().any(|(k, _)| *k == "FAKE_LSP_EXTERNAL") {
        env.push(("FAKE_LSP_EXTERNAL", "/nonexistent/site.py"));
    }
    fake_env(&t.path, Some("fake"), &env);
    let overrides: HashMap<LanguageId, String> = overrides.iter().map(|(l, c)| (*l, (*c).to_owned())).collect();
    let s = TestServer::with_lsp(t, req, Some(overrides)).await;
    Some(s)
}

/// Waits until the server for `command` is ready to answer.
async fn ready(s: &TestServer) {
    eventually("a ready server", || {
        s.lsp.as_ref().unwrap().status().servers.iter().any(|x| x.state == diffle::protocol::LspState::Ready)
    })
    .await;
}

fn file_query(path: &str, rev: &str) -> String {
    let encoded: String = form_urlencoded::byte_serialize(path.as_bytes()).collect();
    format!("/api/file?path={encoded}&rev={rev}")
}

#[tokio::test]
async fn get_api_file_serves_a_file_outside_the_snapshot_only_after_the_language_server_named_it() {
    let (outside, dir) = root();
    let (site, secret) = (dir.join("site.py"), dir.join("secret.py"));
    std::fs::write(&site, "import sys\n").unwrap();
    std::fs::write(&secret, "token = 1\n").unwrap();
    let site_s = site.to_string_lossy().into_owned();
    let t = python_repo();
    t.write("source.py", "import sys\n");
    let overrides = [(LanguageId::Python, "fake")];
    let Some(s) = serve(t, EnterRequest::Working, &[("FAKE_LSP_EXTERNAL", &site_s)], &overrides).await else { return };
    ready(&s).await;
    assert_eq!(s.get(&file_query(&site_s, "new")).await.status, 404);
    let def = s.json("POST", "/api/lsp/definition", json!({ "path": "source.py", "line": 1, "col": 0 })).await;
    assert_eq!(def.status, 200, "{}", def.body);
    let external = json!({ "path": site_s, "line": 1, "col": 0, "text": "import sys", "external": true });
    assert!(def.json()["locations"].as_array().unwrap().contains(&external), "{}", def.body);
    let served = s.get(&file_query(&site_s, "new")).await;
    assert_eq!(
        (served.status, served.json()),
        (200, json!({ "path": site_s, "contents": "import sys\n", "binary": false }))
    );
    // Only the new side, and only paths the server returned: a neighbour file stays unreadable.
    assert_eq!(s.get(&file_query(&site_s, "old")).await.status, 404);
    assert_eq!(s.get(&file_query(&secret.to_string_lossy(), "new")).await.status, 404);
    // The log is listed by command; the fake writes each document it opens to stderr.
    let opened = json!({ "source": "stderr", "level": "log", "message": "open source.py v1", "count": 1 });
    let has_open = |log: &Value| {
        log["entries"].as_array().is_some_and(|e| {
            e.iter().any(|x| ["source", "level", "message", "count"].iter().all(|k| x[*k] == opened[*k]))
        })
    };
    let log = s.get("/api/lsp/log?server=fake").await;
    assert_eq!(log.status, 200);
    assert!(has_open(&log.json()), "{}", log.body);
    assert_eq!(s.get("/api/lsp/log?server=other").await.status, 404);
    s.close().await;
    drop(outside);
}

#[tokio::test]
async fn answers_definition_hover_references_occurrences_and_symbols() {
    let overrides = [(LanguageId::Python, "fake")];
    let Some(s) = serve(python_repo(), EnterRequest::Working, &[], &overrides).await else { return };
    ready(&s).await;
    let status = s.get("/api/lsp/status").await.json();
    assert_eq!((status["enabled"].clone(), status["servers"][0]["name"].clone()), (json!(true), json!("fake")));
    let at = json!({ "path": "source.py", "line": 3, "col": 4 });
    let def = s.json("POST", "/api/lsp/definition", at.clone()).await;
    assert_eq!(def.json(), json!({ "locations": [{ "path": "source.py", "line": 2, "col": 4, "text": "def f():" }] }));
    // The fake answers no type definitions: an empty answer, not a refusal.
    let typed = s.json("POST", "/api/lsp/type-definition", at.clone()).await;
    assert_eq!((typed.status, typed.json()), (200, json!({ "locations": [] })));
    let hover = s.json("POST", "/api/lsp/hover", json!({ "path": "source.py", "line": 2, "col": 4 })).await;
    assert_eq!(
        hover.json(),
        json!({
            "contents": "```python\ndef f() -> None\n```\n\nDoes the `f` thing.",
            "range": { "line": 2, "col": 4, "endLine": 2, "endCol": 5 },
        })
    );
    let refs = s.json("POST", "/api/lsp/references", json!({ "path": "source.py", "line": 1, "col": 0 })).await;
    let paths: Vec<Value> = refs.json()["locations"].as_array().unwrap().iter().map(|l| l["path"].clone()).collect();
    assert_eq!(paths, [json!("source.py"), json!("other.py")]);
    let occ = s.json("POST", "/api/lsp/occurrences", json!({ "path": "source.py", "line": 1, "col": 0 })).await;
    assert_eq!(
        occ.json(),
        json!({ "occurrences": [{ "line": 1, "col": 0, "endLine": 1, "endCol": 6, "kind": "read" }] })
    );
    let doc = s.get("/api/lsp/symbols?path=source.py").await.json();
    let names: Vec<Value> = doc["symbols"].as_array().unwrap().iter().map(|x| x["name"].clone()).collect();
    assert_eq!(names, [json!("Foo"), json!("bar"), json!("baz")]);
    let workspace = s.get("/api/lsp/symbols?q=q").await.json();
    assert_eq!(
        workspace,
        json!({ "symbols": [{ "name": "q_sym", "kind": 12, "container": "mod", "path": "other.py", "line": 5, "endLine": 5, "col": 2 }] })
    );
    s.close().await;
}

#[tokio::test]
async fn refuses_with_the_reason_lsp_blocker_gives() {
    let overrides = [(LanguageId::Python, "fake"), (LanguageId::Go, "")];
    // Go enters the diff, so its configured off switch is what refuses it.
    let t = python_repo();
    t.write("main.go", "package main\n");
    let Some(s) = serve(t, EnterRequest::Working, &[("FAKE_LSP_OFFERS", "hover")], &overrides).await else {
        return;
    };
    ready(&s).await;
    let refused = |path: &'static str| {
        let s = &s;
        async move {
            let r = s.json("POST", "/api/lsp/definition", json!({ "path": path, "line": 1, "col": 0 })).await;
            (r.status, r.json()["error"].as_str().unwrap_or_default().to_owned())
        }
    };
    assert_eq!(refused("notes.txt").await, (409, "No language server for .txt files".to_owned()));
    assert_eq!(refused("main.go").await, (409, "The language server for go is off in your diffle config".to_owned()));
    assert_eq!(refused("source.py").await, (409, "fake offers no go to definition".to_owned()));
    // The blocker speaks first; a feature the server offers reaches the snapshot check.
    let gone = s.json("POST", "/api/lsp/hover", json!({ "path": "gone.py", "line": 1, "col": 0 })).await;
    assert_eq!((gone.status, gone.json()), (409, json!({ "error": "gone.py is not in the snapshot" })));
    // Occurrences are advisory: a server not offering highlights answers none.
    let occ = s.json("POST", "/api/lsp/occurrences", json!({ "path": "source.py", "line": 1, "col": 0 })).await;
    assert_eq!((occ.status, occ.json()), (200, json!({ "occurrences": [] })));
    s.close().await;
}

#[tokio::test]
async fn refuses_symbol_navigation_when_the_new_side_is_not_the_checkout() {
    let overrides = [(LanguageId::Python, "fake")];
    let Some(s) = serve(python_repo(), revspec(&["HEAD~1^!"]), &[], &overrides).await else { return };
    let r = s.json("POST", "/api/lsp/hover", json!({ "path": "source.py", "line": 1, "col": 0 })).await;
    assert_eq!(
        (r.status, r.json()),
        (409, json!({ "error": "Symbol navigation needs the new side to be the worktree or the checked-out commit" }))
    );
    // Nothing tracked, so nothing started: the run's servers start for files they would read.
    assert!(s.lsp.as_ref().unwrap().status().servers.is_empty());
    s.close().await;
}
