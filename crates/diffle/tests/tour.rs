//! Tours: pushed, refused with every reason, cleared, and kept across refreshes; and `diffle tour`
//! as an agent runs it.
mod common;

use std::process::{Command, Output, Stdio};
use std::time::Duration;

use common::TestRepo;
use common::cli::{diffle, serve, stderr, stdout};
use common::server::TestServer;
use diffle::protocol::EnterRequest;
use futures::StreamExt;
use serde_json::{Value, json};

/// `app.py` changed in the worktree: line 2 added, line 3 changed; `added.py` new there.
async fn server() -> TestServer {
    let repo = TestRepo::new();
    repo.write("app.py", "import os\ndef old(): pass\n");
    repo.write("docs/readme.md", "docs\n");
    repo.commit("base");
    repo.write("app.py", "import os\ndef load_user(id):\n    return id\n");
    repo.write("added.py", "x = 1\n");
    TestServer::over(repo, EnterRequest::Working).await
}

const TOUR: &str = r#"
<diffle-card id="entry" step="1" title="Where it starts">
  <p>The loader is <strong>new</strong>.</p>
  <table><thead><tr><th>Before</th><th>After</th></tr></thead>
  <tbody><tr><td>old</td><td>load_user</td></tr><tr><td colspan="2">same file</td></tr></tbody></table>
  <diffle-diff path="app.py" lines="2-3"></diffle-diff>
  <diffle-jump path="app.py" line="2">see it</diffle-jump>
</diffle-card>
<diffle-group title="Docs">
  <diffle-card id="docs" title="Docs">
    <diffle-tree paths="app.py
docs/readme.md"></diffle-tree>
    <diffle-callout kind="note"><p>Unchanged.</p></diffle-callout>
    <diffle-symbol path="app.py" line="2" name="load_user"></diffle-symbol>
  </diffle-card>
</diffle-group>
"#;

async fn push(s: &TestServer, html: &str) -> common::server::Res {
    s.json("PUT", "/api/tour", json!({ "html": html })).await
}

async fn tour(s: &TestServer) -> Value {
    s.get("/api/tour").await.json()["tour"].clone()
}

#[tokio::test]
async fn keeps_a_pushed_tour_under_the_comment_key_and_tells_clients() {
    let s = server().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(s.ws_url()).await.unwrap();
    assert_eq!(tour(&s).await, Value::Null);

    let pushed = push(&s, TOUR).await;
    assert_eq!(pushed.status, 200, "{}", pushed.body);
    let pushed = pushed.json();
    assert_eq!(pushed["html"], TOUR);
    assert_eq!(pushed["version"], s.get("/api/snapshot").await.json()["version"]);
    assert_eq!(tour(&s).await, pushed);
    let key = s.get("/api/snapshot").await.json()["commentKey"].as_str().unwrap().to_owned();
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(s.repo.path.join(".git/diffle/tours.json")).unwrap()).unwrap();
    assert_eq!(stored["tours"][&key], pushed);
    assert!(told_of_tour(&mut ws).await);
    s.close().await;
}

/// Whether the socket carries a `tour` message within a few seconds.
async fn told_of_tour(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) -> bool {
    let wait = async {
        while let Some(Ok(message)) = ws.next().await {
            let Ok(text) = message.to_text() else { continue };
            if serde_json::from_str::<Value>(text).is_ok_and(|m| m["type"] == "tour") {
                return true;
            }
        }
        false
    };
    tokio::time::timeout(Duration::from_secs(5), wait).await.unwrap_or(false)
}

#[tokio::test]
async fn refuses_a_tour_with_every_reason_in_document_order() {
    let s = server().await;
    let html = r#"
<style>p { color: red }</style>
stray text
<diffle-card id="a" step="1" title="A" color="red">
  <img src="x.png">
  <p onclick="steal()">Hi <a href="javascript:alert(1)">there</a></p>
  <diffle-diff path="missing.py" lines="1-2"></diffle-diff>
  <diffle-diff path="added.py" side="old" lines="1"></diffle-diff>
  <table><tr><td rowspan="0" align="left">x</td></tr></table>
  <diffle-diff path="app.py" lines="2-9"></diffle-diff>
  <diffle-diff path="app.py" side="old" lines="3"></diffle-diff>
  <diffle-diff path="app.py" lines="5-2"></diffle-diff>
  <diffle-symbol path="app.py" line="2" name="load"></diffle-symbol>
  <diffle-card id="nested" title="Nested"></diffle-card>
  <diffle-callout kind="aside"></diffle-callout>
</diffle-card>
<diffle-card id="a" step="1" title="Again"></diffle-card>
<diffle-card id="b" step="x" title="B"><diffle-tree root="src" paths="src/a.py
docs/readme.md"></diffle-tree></diffle-card>
<diffle-card id="d" title="D"><diffle-tree paths="app.py"/><p>after</p></diffle-card>
<diffle-card id="c" title="C"></diffle-card>
<diffle-shape></diffle-shape>
"#;
    let refused = push(&s, html).await;
    assert_eq!(refused.status, 422, "{}", refused.body);
    insta::assert_json_snapshot!("refused", refused.json());
    assert_eq!(tour(&s).await, Value::Null);
    let empty = push(&s, "<p>no cards</p>").await;
    assert_eq!(empty.json()["errors"].as_array().unwrap().len(), 2, "{}", empty.body);
    s.close().await;
}

#[tokio::test]
async fn keeps_the_tour_across_refreshes_until_cleared() {
    let s = server().await;
    let pushed = push(&s, TOUR).await.json();
    // The card's lines leave the diff; the tour stays as pushed, and the client marks the card stale.
    s.repo.write("app.py", "import os\n");
    s.session.refresh().await;
    assert!(s.get("/api/snapshot").await.json()["version"].as_i64() > pushed["version"].as_i64());
    assert_eq!(tour(&s).await, pushed);

    let (mut ws, _) = tokio_tungstenite::connect_async(s.ws_url()).await.unwrap();
    assert_eq!(s.send("DELETE", "/api/tour", &[], None).await.status, 204);
    assert_eq!(tour(&s).await, Value::Null);
    assert!(told_of_tour(&mut ws).await);
    // Clearing nothing succeeds too.
    assert_eq!(s.send("DELETE", "/api/tour", &[], None).await.status, 204);
    s.close().await;
}

/// `diffle tour <args> -C <repo>`, with `stdin` piped in.
fn tour_cli(repo: &std::path::Path, args: &[&str], stdin: &str) -> Output {
    let config = tempfile::tempdir().unwrap();
    let mut cmd: Command = diffle(config.path(), &[&["tour"], args, &["-C", repo.to_str().unwrap()]].concat());
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), stdin.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn pushes_and_clears_a_tour_from_the_command_line() {
    let t = TestRepo::new();
    t.write("app.py", "x = 1\n");
    t.commit("base");
    t.write("app.py", "x = 1\ny = 2\n");
    let config = tempfile::tempdir().unwrap();
    let (mut child, url, _) = serve(config.path(), &t.path, &["--port", "0"]);
    let file = t.path.join("tour.html");
    std::fs::write(
        &file,
        r#"<diffle-card id="a" title="A"><diffle-diff path="app.py" lines="2"></diffle-diff></diffle-card>"#,
    )
    .unwrap();

    let pushed = tour_cli(&t.path, &["push", file.to_str().unwrap()], "");
    assert!(pushed.status.success(), "{}", stderr(&pushed));
    let tour: Value = serde_json::from_str(&stdout(&pushed)).unwrap();
    assert_eq!(tour["html"], std::fs::read_to_string(&file).unwrap());

    let refused = tour_cli(&t.path, &["push", "-"], r#"<diffle-card id="a" title="A"><diffle-edge></diffle-card>"#);
    assert_eq!(refused.status.code(), Some(2), "{}", stderr(&refused));
    assert_eq!(stdout(&refused), "");
    insta::assert_snapshot!("cli_refused", stderr(&refused));

    let cleared = tour_cli(&t.path, &["clear"], "");
    assert!(cleared.status.success(), "{}", stderr(&cleared));
    let (_, body) = common::cli::http(&url, "GET", "/api/tour", "");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap(), json!({ "tour": null }));
    let _ = child.kill();
    let _ = child.wait();
}
