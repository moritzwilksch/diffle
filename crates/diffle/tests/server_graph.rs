//! `GET /api/graph` over fake language servers scripted with a code graph: what it groups, how it
//! degrades without a server, and that one snapshot costs one build.
#![cfg(unix)]
mod common;

use std::collections::HashMap;

use serde_json::{Value, json};

use common::lsp::{events, fake_env, fake_servers, flush};
use common::server::TestServer;
use common::{TestRepo, revspec};
use diffle::graph::collect::build;
use diffle::graph::limits::Limits;
use diffle::graph::source::PoolSource;
use diffle::protocol::{EnterRequest, LanguageId};

/// Python files `alpha` (a.py) is used by `beta` (b.py) and by the unchanged caller.py; c.py and d.py
/// are used by nothing. The worktree edits all four bodies, drops gone.py and touches notes.md.
fn repo() -> TestRepo {
    let t = TestRepo::new();
    // The fake's environment and script live in the root; keep them out of the review.
    std::fs::write(t.path.join(".git/info/exclude"), ".fake-*\n").unwrap();
    for (name, def) in [("a", "alpha"), ("b", "beta"), ("c", "gamma"), ("d", "delta")] {
        t.write(&format!("{name}.py"), format!("def {def}():\n    return 1\n"));
    }
    t.write("caller.py", "import a\nx = 1\ny = 2\nprint(a.alpha())\n");
    t.write("notes.md", "notes\n");
    t.write("gone.py", "x = 1\n");
    t.commit("base");
    for name in ["a", "b", "c", "d"] {
        t.write(&format!("{name}.py"), format!("def {name}():\n    return 2\n"));
    }
    t.write("notes.md", "more notes\n");
    t.rm("gone.py");
    t
}

/// The graph the fake serves for `repo()`: what `alpha` uses and where.
fn repo_graph() -> Value {
    let outline = |name: &str| json!([{ "name": name, "kind": 12, "line": 1, "endLine": 2, "col": 4 }]);
    json!({
        "outlines": { "a.py": outline("alpha"), "b.py": outline("beta"), "c.py": outline("gamma"), "d.py": outline("delta") },
        "references": { "a.py:1:4": [
            { "path": "a.py", "line": 1, "col": 4 },
            { "path": "b.py", "line": 2, "col": 4 },
            { "path": "caller.py", "line": 4, "col": 8 },
        ] },
    })
}

fn script(t: &TestRepo, graph: &Value) -> String {
    let path = t.path.join(".fake-graph.json");
    std::fs::write(&path, graph.to_string()).unwrap();
    path.to_string_lossy().into_owned()
}

async fn serve(t: TestRepo, req: EnterRequest, overrides: &[(LanguageId, &str)]) -> Option<TestServer> {
    serve_env(t, req, overrides, &[]).await
}

/// The default python server with extra environment for the fake.
async fn serve_with(t: TestRepo, extra: &[(&str, &str)]) -> Option<TestServer> {
    serve_env(t, EnterRequest::Working, &[(LanguageId::Python, "fake")], extra).await
}

async fn serve_env(
    t: TestRepo,
    req: EnterRequest,
    overrides: &[(LanguageId, &str)],
    extra: &[(&str, &str)],
) -> Option<TestServer> {
    serve_graph(t, &repo_graph(), req, overrides, extra).await
}

/// The fake served `graph`, a script of outlines and references.
async fn serve_graph(
    t: TestRepo,
    graph: &Value,
    req: EnterRequest,
    overrides: &[(LanguageId, &str)],
    extra: &[(&str, &str)],
) -> Option<TestServer> {
    fake_servers()?;
    let graph = script(&t, graph);
    let vars: Vec<(&str, &str)> =
        [("FAKE_LSP_GRAPH", graph.as_str())].into_iter().chain(extra.iter().copied()).collect();
    fake_env(&t.path, Some("fake"), &vars);
    let overrides: HashMap<LanguageId, String> = overrides.iter().map(|(l, c)| (*l, (*c).to_owned())).collect();
    Some(TestServer::with_lsp(t, req, Some(overrides)).await)
}

async fn graph(s: &TestServer) -> Value {
    let res = s.get("/api/graph").await;
    assert_eq!(res.status, 200, "{}", res.body);
    res.json()
}

/// How many `references` queries the fake has served.
async fn queries(s: &TestServer) -> usize {
    let process = s.lsp.as_ref().unwrap().server("fake").unwrap().bridge.process().clone();
    flush(&process).await;
    events(&process).iter().filter(|e| e.starts_with("references ")).count()
}

/// The positions the fake was asked for references at, as `path:line:col`.
async fn asked(s: &TestServer) -> Vec<String> {
    let process = s.lsp.as_ref().unwrap().server("fake").unwrap().bridge.process().clone();
    flush(&process).await;
    events(&process).iter().filter_map(|e| e.strip_prefix("references ")).map(str::to_owned).collect()
}

async fn version(s: &TestServer) -> i64 {
    s.get("/api/snapshot").await.json()["version"].as_i64().unwrap()
}

fn paths(graph: &Value) -> Vec<String> {
    let strings = |v: &Value| v.as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let mut all: Vec<String> =
        graph["clusters"].as_array().unwrap().iter().flat_map(|c| strings(&c["files"])).collect();
    all.extend(strings(&graph["unlinked"]));
    all.extend(strings(&graph["other"]));
    all.sort();
    all
}

#[tokio::test]
async fn groups_changed_files_by_who_references_whom_and_lists_unchanged_callers() {
    let Some(s) = serve(repo(), EnterRequest::Working, &[(LanguageId::Python, "fake")]).await else { return };
    let got = graph(&s).await;
    assert_eq!(
        got,
        json!({
            "version": version(&s).await,
            "clusters": [{
                "id": "a.py", "label": "", "files": ["a.py", "b.py"], "symbols": 2,
                "context": [{
                    "path": "caller.py", "refs": 1,
                    "uses": [{ "symbol": "alpha", "kind": 12, "path": "a.py", "lines": [4] }],
                }],
                "contextTotal": 1,
                "links": [{
                    "from": "b.py", "to": "a.py", "weight": 1, "total": 1,
                    "uses": [{ "symbol": "alpha", "kind": 12, "path": "a.py", "lines": [2] }],
                }],
                "linksTotal": 1,
            }],
            "unlinked": ["c.py", "d.py"],
            "other": ["gone.py", "notes.md"],
        })
    );
    let snapshot = s.get("/api/snapshot").await.json();
    let mut changed: Vec<String> =
        snapshot["changed"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
    changed.sort();
    assert_eq!(paths(&got), changed, "every changed file exactly once");
    s.close().await;
}

/// Single flight itself is proved in the cache's unit tests, where a gate holds the first build open;
/// the fake language server has no delay to overlap two requests with.
#[tokio::test]
async fn a_snapshot_is_built_once_however_often_it_is_asked_and_a_new_version_builds_again() {
    let Some(s) = serve(repo(), EnterRequest::Working, &[(LanguageId::Python, "fake")]).await else { return };
    let first = graph(&s).await;
    assert_eq!(queries(&s).await, 4, "one reference query per changed symbol, once");
    assert_eq!(graph(&s).await, first);
    assert_eq!(queries(&s).await, 4, "a later request reuses the build");
    let before = version(&s).await;
    s.repo.write("c.py", "def c():\n    return 3\n");
    s.session.reload().await.unwrap();
    let rebuilt = graph(&s).await;
    assert!(rebuilt["version"].as_i64().unwrap() > before, "{rebuilt}");
    assert_eq!(rebuilt["version"], json!(version(&s).await));
    assert_eq!(queries(&s).await, 8, "a new snapshot is built afresh");
    s.close().await;
}

#[tokio::test]
async fn a_build_for_a_superseded_snapshot_reads_that_snapshots_patches_and_carries_its_version() {
    let Some(s) = serve(repo(), EnterRequest::Working, &[(LanguageId::Python, "fake")]).await else { return };
    let snapshotter = s.session.snapshotter().unwrap();
    let old = snapshotter.current().await.unwrap();
    // Committing moves HEAD: the next snapshot changes nothing, while `old` still names its edits.
    s.repo.commit("land the edits");
    s.session.reload().await.unwrap();
    let new = snapshotter.current().await.unwrap();
    assert!(new.version > old.version && new.changed.is_empty(), "{:?}", new.changed);
    let source = PoolSource::new(s.lsp.clone(), snapshotter, old.clone());
    let (graph, _) = build(&source, &old, &Limits::DEFAULT).await.unwrap();
    assert_eq!(graph.version, old.version);
    let files: Vec<_> = graph.clusters.iter().flat_map(|c| c.files.clone()).collect();
    assert_eq!(
        (files, graph.unlinked, graph.other),
        (
            vec!["a.py".into(), "b.py".into()],
            vec!["c.py".into(), "d.py".into()],
            vec!["gone.py".into(), "notes.md".into()]
        )
    );
    s.close().await;
}

#[tokio::test]
async fn a_server_that_refuses_every_request_still_gets_an_answer_with_every_file_other() {
    let t = repo();
    let Some(s) = serve_with(t, &[("FAKE_LSP_MODIFIED", "100000")]).await else { return };
    let got = graph(&s).await;
    assert_eq!(got["clusters"], json!([]));
    assert_eq!(got["unlinked"], json!([]));
    assert_eq!(got["other"], json!(["a.py", "b.py", "c.py", "d.py", "gone.py", "notes.md"]));
    assert!(got["note"].is_string(), "{got}");
    s.close().await;
}

#[tokio::test]
async fn without_a_server_for_the_diff_every_file_is_other_with_the_reason() {
    let Some(s) = serve(repo(), EnterRequest::Working, &[(LanguageId::Python, "")]).await else { return };
    let got = graph(&s).await;
    assert_eq!(got["note"], json!("The language server for python is off in your diffle config"));
    assert_eq!(got["clusters"], json!([]));
    assert_eq!(got["unlinked"], json!([]));
    assert_eq!(got["other"], json!(["a.py", "b.py", "c.py", "d.py", "gone.py", "notes.md"]));
    s.close().await;
}

#[tokio::test]
async fn with_language_servers_off_the_graph_still_answers() {
    let s = TestServer::over(repo(), EnterRequest::Working).await;
    let got = graph(&s).await;
    assert_eq!(got["note"], json!("Language servers are off for this run (--no-lsp)"));
    assert_eq!(got["other"], json!(["a.py", "b.py", "c.py", "d.py", "gone.py", "notes.md"]));
    assert_eq!(got["version"], json!(version(&s).await));
    s.close().await;
}

#[tokio::test]
async fn a_snapshot_that_is_not_the_checkout_degrades_to_other() {
    let t = repo();
    t.commit("second");
    let Some(s) = serve(t, revspec(&["HEAD~1^!"]), &[(LanguageId::Python, "fake")]).await else { return };
    let got = graph(&s).await;
    assert_eq!(got["note"], json!("Symbol navigation needs the new side to be the worktree or the checked-out commit"));
    assert_eq!(got["clusters"], json!([]));
    assert_eq!(got["unlinked"], json!([]));
    // HEAD~1^! shows the base commit, which added all seven files.
    assert_eq!(got["other"], json!(["a.py", "b.py", "c.py", "caller.py", "d.py", "gone.py", "notes.md"]));
    s.close().await;
}

const KIND: &str = "class Kind:\n    NAME = \"kind\"\n    def label(self):\n        return \"label for kind\"\n    def code(self):\n        return \"code for kind\"\n";

/// `home.py` hands the class `Kind` over to `lifecycle.py`, edited on the way or not, while two callers
/// that use it change for a reason of their own.
fn moved_repo(edited: bool) -> TestRepo {
    let t = TestRepo::new();
    std::fs::write(t.path.join(".git/info/exclude"), ".fake-*\n").unwrap();
    t.write("home.py", format!("import os\n\n{KIND}\ndef stay():\n    return 1\n"));
    t.write("lifecycle.py", "def lifecycle():\n    return 0\n");
    for name in ["use_a", "use_b"] {
        t.write(&format!("{name}.py"), "def run():\n    return 1\n");
    }
    t.commit("base");
    t.write("home.py", "import os\n\ndef stay():\n    return 1\n");
    let carried = if edited { KIND.replace("code for kind", "code for the kind") } else { KIND.to_owned() };
    t.write("lifecycle.py", format!("def lifecycle():\n    return 0\n\n{carried}"));
    for name in ["use_a", "use_b"] {
        t.write(&format!("{name}.py"), "def run():\n    return 2\n");
    }
    t
}

fn moved_graph() -> Value {
    let one =
        |name: &str, line: u32, end: u32| json!([{ "name": name, "kind": 12, "line": line, "endLine": end, "col": 4 }]);
    json!({
        "outlines": {
            "home.py": one("stay", 3, 4),
            "lifecycle.py": [
                { "name": "lifecycle", "kind": 12, "line": 1, "endLine": 2, "col": 4 },
                { "name": "Kind", "kind": 5, "line": 4, "endLine": 9, "col": 6 },
            ],
            "use_a.py": one("run", 1, 2),
            "use_b.py": one("run", 1, 2),
        },
        "references": { "lifecycle.py:4:6": [
            { "path": "use_a.py", "line": 2, "col": 4 },
            { "path": "use_b.py", "line": 2, "col": 4 },
        ] },
    })
}

#[tokio::test]
async fn a_class_moved_verbatim_to_another_file_makes_no_arrow_into_it() {
    let python = [(LanguageId::Python, "fake")];
    let Some(s) = serve_graph(moved_repo(false), &moved_graph(), EnterRequest::Working, &python, &[]).await else {
        return;
    };
    let got = graph(&s).await;
    assert_eq!(got["clusters"], json!([]), "{got}");
    assert_eq!(got["unlinked"], json!(["home.py", "lifecycle.py", "use_a.py", "use_b.py"]));
    assert!(!asked(&s).await.contains(&"lifecycle.py:4:6".to_owned()), "the moved class was asked about");
    s.close().await;
}

#[tokio::test]
async fn a_class_moved_and_edited_on_the_way_keeps_its_arrows() {
    let python = [(LanguageId::Python, "fake")];
    let Some(s) = serve_graph(moved_repo(true), &moved_graph(), EnterRequest::Working, &python, &[]).await else {
        return;
    };
    let got = graph(&s).await;
    let clusters = got["clusters"].as_array().unwrap();
    assert_eq!(clusters.len(), 1, "{got}");
    assert_eq!(clusters[0]["files"], json!(["lifecycle.py", "use_a.py", "use_b.py"]));
    let links: Vec<(&str, &str, i64)> = clusters[0]["links"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| (l["from"].as_str().unwrap(), l["to"].as_str().unwrap(), l["weight"].as_i64().unwrap()))
        .collect();
    assert_eq!(links, [("use_a.py", "lifecycle.py", 1), ("use_b.py", "lifecycle.py", 1)]);
    s.close().await;
}

/// `kind.rs` holds `enum Kind` and `impl Kind`, both touched; `user.rs` uses the enum once.
fn impl_repo() -> TestRepo {
    let t = TestRepo::new();
    std::fs::write(t.path.join(".git/info/exclude"), ".fake-*\n").unwrap();
    let kind = |a: &str, tag: u8| {
        format!(
            "pub enum Kind {{\n    {a},\n    B,\n}}\n\nimpl Kind {{\n    const TAG: u8 = {tag};\n    pub fn label(&self) -> u8 {{\n        1\n    }}\n}}\n"
        )
    };
    t.write("kind.rs", kind("A", 1));
    t.write("user.rs", "fn caller() {\n    let _ = Kind::A;\n}\n");
    t.commit("base");
    t.write("kind.rs", kind("A2", 2));
    t.write("user.rs", "fn caller() {\n    let _ = Kind::A2;\n}\n");
    t
}

#[tokio::test]
async fn an_impl_block_beside_its_enum_does_not_make_the_enum_two_used_symbols() {
    // Like rust-analyzer, the fake answers the enum's uses at the impl's position too.
    let uses = json!([{ "path": "user.rs", "line": 2, "col": 12 }]);
    let graph_script = json!({
        "outlines": {
            "kind.rs": [
                { "name": "Kind", "kind": 10, "line": 1, "endLine": 4, "col": 9 },
                { "name": "impl Kind", "kind": 19, "line": 6, "endLine": 11, "col": 5, "children": [
                    { "name": "label", "kind": 12, "line": 8, "endLine": 10, "col": 11 },
                ] },
            ],
            "user.rs": [{ "name": "caller", "kind": 12, "line": 1, "endLine": 3, "col": 3 }],
        },
        "references": { "kind.rs:1:9": uses, "kind.rs:6:5": uses },
    });
    let rust = [(LanguageId::Rust, "fake")];
    let Some(s) = serve_graph(impl_repo(), &graph_script, EnterRequest::Working, &rust, &[]).await else { return };
    let got = graph(&s).await;
    assert_eq!(
        got["clusters"][0]["links"],
        json!([{
            "from": "user.rs", "to": "kind.rs", "weight": 1, "total": 1,
            "uses": [{ "symbol": "Kind", "kind": 10, "path": "kind.rs", "lines": [2] }],
        }]),
        "{got}"
    );
    let mut asked = asked(&s).await;
    asked.sort();
    assert_eq!(asked, ["kind.rs:1:9", "user.rs:1:3"], "the impl is not asked what uses it");
    s.close().await;
}
