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
<h1>Loading users</h1>
<p>One change, read in two sections.</p>
<h2>Where it starts</h2>
<p>The loader is <strong>new</strong>: <diffle-symbol path="app.py" line="2" name="load_user"></diffle-symbol> takes an id
(<diffle-jump path="app.py" line="2">see it</diffle-jump>).</p>
<diffle-card id="entry" title="The loader returns the id">
  <p>It replaces <code>old</code>.</p>
  <diffle-diff path="app.py" lines="2-3"></diffle-diff>
</diffle-card>
<diffle-row>
  <div><p>The name changes, the file stays.</p></div>
  <table><thead><tr><th>Before</th><th>After</th></tr></thead>
  <tbody><tr><td>old</td><td>load_user</td></tr><tr><td colspan="2">same file</td></tr></tbody></table>
</diffle-row>
<diffle-diagram><svg viewBox="0 0 320 72">
  <g class="accent"><rect x="8" y="16" width="120" height="40"/><text x="20" y="36" class="bold">Loader</text></g>
  <path d="M128 36 H192" class="arrow"/>
  <rect x="192" y="16" width="120" height="40" class="fill"/>
  <text x="252" y="36" class="c">User <tspan class="mono">id</tspan></text>
</svg></diffle-diagram>
<h2>Docs</h2>
<h3>Layout</h3>
<diffle-tree paths="app.py
docs/readme.md"></diffle-tree>
<diffle-callout kind="info"><p>Unchanged.</p></diffle-callout>
<diffle-callout kind="danger"><p>Callers of <code>old</code> break.</p></diffle-callout>
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
    assert_eq!(pushed["warnings"], json!([]));
    let pushed = pushed["tour"].clone();
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
<h2>A</h2>
<h1>Late title</h1>
<diffle-jump path="app.py">at the top</diffle-jump>
<img src="x.png">
<p onclick="steal()">Hi <a href="javascript:alert(1)">there</a> <diffle-diff path="app.py" lines="2"></diffle-diff></p>
<diffle-diff path="missing.py" lines="1-2"></diffle-diff>
<diffle-diff path="added.py" side="old" lines="1"></diffle-diff>
<table><tr><td rowspan="0" align="left">x</td></tr></table>
<diffle-diagram><svg viewBox="0 0 100 50">
  <defs><marker id="m"></marker></defs>
  <rect x="1" y="1" width="10" height="10" fill="red" class="box"/>
  <tspan>loose</tspan>
  <path d="M0 0 L10 10" class="arrow" marker-end="url(#m)"/>
  <text x="1" y="1"><rect x="1" y="1" width="2" height="2"/></text>
  <circle cx="5" cy="5"/>
</svg></diffle-diagram>
<p>A stray <svg viewBox="0 0 1 1"></svg> drawing.</p>
<diffle-diff path="app.py" lines="2-9"></diffle-diff>
<diffle-diff path="app.py" side="old" lines="3"></diffle-diff>
<diffle-diff path="app.py" lines="5-2"></diffle-diff>
<p><diffle-symbol path="app.py" line="2" name="load"></diffle-symbol></p>
<diffle-card id="a" title="A" step="1" color="red">
  <diffle-card id="nested" title="Nested"><diffle-diff path="app.py" lines="2"></diffle-diff></diffle-card>
  <diffle-callout kind="note"><diffle-callout kind="info"></diffle-callout><h2>Inside</h2></diffle-callout>
</diffle-card>
<diffle-card id="a" title="Again"><diffle-diff path="app.py" lines="2"></diffle-diff></diffle-card>
<diffle-tree root="src" paths="src/a.py
docs/readme.md"></diffle-tree>
<diffle-group title="G"></diffle-group>
<diffle-row><p>alone</p></diffle-row>
<diffle-row>loose text<h2>In a row</h2><img src="x.png"><diffle-row><p>a</p><p>b</p></diffle-row></diffle-row>
<h1>Second title</h1>
<diffle-tree paths="app.py"/><p>after</p>
"#;
    let refused = push(&s, html).await;
    assert_eq!(refused.status, 422, "{}", refused.body);
    insta::assert_json_snapshot!("refused", refused.json());
    assert_eq!(tour(&s).await, Value::Null);
    let empty = push(&s, "<p>no sections</p>").await;
    assert_eq!(empty.json()["errors"].as_array().unwrap().len(), 1, "{}", empty.body);
    s.close().await;
}

#[tokio::test]
async fn keeps_the_tour_across_refreshes_until_cleared() {
    let s = server().await;
    let pushed = push(&s, TOUR).await.json()["tour"].clone();
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

/// The demo tour's first diagram, as an agent drew it before `--skill` said how text sits: labels on
/// a baseline below their boxes' middles, mono labels wider than their boxes, off the grid.
const CROWDED: &str = r#"<h2>Flow</h2>
<diffle-row><p>The new line.</p><diffle-diff path="app.py" lines="2"></diffle-diff></diffle-row>
<diffle-row><p>Too wide for its column.</p><diffle-diagram><svg viewBox="0 0 720 40"></svg></diffle-diagram></diffle-row>
<diffle-diagram><svg viewBox="0 0 1000 96">
  <rect x="4" y="24" width="100" height="40" class="fill"></rect>
  <text x="54" y="48" class="c small">agent</text>
  <rect x="248" y="24" width="104" height="40" class="fill accent"></rect>
  <text x="300" y="44" class="c mono">PUT /api/tour</text>
  <g class="accent"><rect x="400" y="24" width="96" height="40"></rect><text x="412" y="44">tours.json and more</text></g>
  <circle cx="600" cy="44" r="16" class="success"></circle>
  <rect x="960" y="24" width="64" height="40"></rect>
  <text x="990" y="88" class="small">ws: tour</text>
</svg></diffle-diagram>"#;

#[tokio::test]
async fn shows_a_tour_whose_diagram_breaks_layout_rules_and_warns_of_each() {
    let s = server().await;
    let pushed = push(&s, CROWDED).await;
    assert_eq!(pushed.status, 200, "{}", pushed.body);
    insta::assert_json_snapshot!("warned", pushed.json()["warnings"]);
    assert_eq!(tour(&s).await["html"], CROWDED);
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
    std::fs::write(&file, r#"<h2>A</h2><diffle-diff path="app.py" lines="2"></diffle-diff>"#).unwrap();

    let pushed = tour_cli(&t.path, &["push", file.to_str().unwrap()], "");
    assert!(pushed.status.success(), "{}", stderr(&pushed));
    let tour: Value = serde_json::from_str(&stdout(&pushed)).unwrap();
    assert_eq!(tour["html"], std::fs::read_to_string(&file).unwrap());
    assert_eq!(stderr(&pushed), "");

    let warned = tour_cli(&t.path, &["push", "-"], CROWDED);
    assert!(warned.status.success(), "{}", stderr(&warned));
    assert!(
        stderr(&warned).starts_with("⚠ the tour was shown, with warnings to judge:\n  h2 \"Flow\" > "),
        "{}",
        stderr(&warned)
    );

    let refused = tour_cli(&t.path, &["push", "-"], r#"<h2>A</h2><p><diffle-edge></diffle-edge></p>"#);
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
