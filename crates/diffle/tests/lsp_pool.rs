//! The run's language servers as a pool, against the fake server in `test/lsp` under several commands.
#![cfg(unix)]
mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use serde_json::{Value, json};

use common::lsp::{events, eventually, fake_env, fake_servers, flush, root};
use diffle::error::Error;
use diffle::lsp::pool::{LspPool, PoolOptions};
use diffle::lsp::registry::Lookup;
use diffle::protocol::{LanguageId, LspPosition, LspState, LspStatus, Snapshot};

const TAILWIND: &str = "tailwindcss-language-server --stdio";

fn files() -> HashMap<String, String> {
    [
        ("a.py", "import os\ndef f():\n    pass\n"),
        ("other.py", "x = 1\ny = 2\nz = f()\n"),
        ("b.go", "package main\nfunc f() {}\n"),
        ("c.txt", "plain\n"),
        ("x.c", "int main(void) { return 0; }\n"),
        ("y.cpp", "int main() { return 0; }\n"),
        ("a.tsx", "const f = 1;\nf;\nf;\n\nexport {};\n"),
        ("b.js", "f();\nf();\n"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect()
}

/// A worktree snapshot changing `paths`; `new_sha`/`head_sha` say whether it is the checkout.
fn diff_at(paths: &[&str], new_sha: &str, head_sha: &str) -> Snapshot {
    let changed: Vec<Value> = paths
        .iter()
        .map(|p| json!({ "path": p, "status": "M", "additions": 0, "deletions": 0, "binary": false, "blob": "", "oldBlob": "", "generated": false }))
        .collect();
    serde_json::from_value(json!({
        "root": "/r", "version": 1, "oldSha": "a", "newSha": new_sha, "headSha": head_sha, "context": 3,
        "review": { "kind": "range", "old": "HEAD", "new": "worktree", "base": "direct", "view": { "kind": "whole" } },
        "follows": "worktree", "commentKey": "working",
        "changed": changed, "tree": paths, "commit": null,
        "commits": { "list": [], "total": 0, "oldSha": "a", "newSha": new_sha }, "iterations": [],
    }))
    .unwrap()
}

fn diff(paths: &[&str]) -> Snapshot {
    diff_at(paths, "worktree", "")
}

struct Started {
    pool: Arc<LspPool>,
    statuses: Arc<Mutex<Vec<LspStatus>>>,
    root: PathBuf,
    _dir: tempfile::TempDir,
}

impl Started {
    /// The fake's document events for the server started by `command`, or none when none was.
    fn events(&self, command: &str) -> Option<Vec<String>> {
        self.pool.server(command).map(|s| events(s.bridge.process()))
    }

    fn commands(&self) -> Vec<String> {
        self.pool.status().servers.into_iter().map(|s| s.command).collect()
    }

    /// Waits until every fake has logged the document events sent so far.
    async fn settle(&self) {
        for command in self.commands() {
            if let Some(server) = self.pool.server(&command) {
                flush(server.bridge.process()).await;
            }
        }
    }
}

struct Setup {
    overrides: Vec<(LanguageId, &'static str)>,
    preload: Vec<LanguageId>,
    lookup: Lookup,
    /// Environment for one command's fake.
    env: Vec<(&'static str, Vec<(&'static str, &'static str)>)>,
    /// Real files in the root, and the snapshot reading every path as `fn main() {}`.
    on_disk: Option<Vec<(&'static str, &'static str)>>,
}

impl Default for Setup {
    fn default() -> Self {
        // Every override names a program the probe would not find, so the pool must not probe them.
        Self { overrides: Vec::new(), preload: Vec::new(), lookup: Arc::new(|_| None), env: Vec::new(), on_disk: None }
    }
}

fn start(setup: Setup) -> Option<Started> {
    fake_servers()?;
    let (dir, root) = root();
    fake_env(&root, None, &[("FAKE_LSP_EXTERNAL", "/nonexistent/site.py")]);
    for (command, vars) in &setup.env {
        let name = command.split(' ').next().unwrap();
        let mut vars = vars.clone();
        vars.push(("FAKE_LSP_EXTERNAL", "/nonexistent/site.py"));
        fake_env(&root, Some(name), &vars);
    }
    let reads_disk = setup.on_disk.is_some();
    for (path, text) in setup.on_disk.unwrap_or_default() {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    let files = Arc::new(files());
    let (served, listed) = (files.clone(), files);
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let record = statuses.clone();
    let pool = LspPool::new(PoolOptions {
        root: root.clone(),
        read: Arc::new(move |p| {
            let text = if reads_disk { Some("fn main() {}\n".to_owned()) } else { served.get(&p).cloned() };
            async move { text }.boxed()
        }),
        has: Arc::new(move |p| {
            let found = reads_disk || listed.contains_key(&p);
            async move { found }.boxed()
        }),
        on_status: Arc::new(move |s| record.lock().unwrap().push(s)),
        overrides: setup.overrides.into_iter().map(|(l, c)| (l, c.to_owned())).collect(),
        preload: setup.preload,
        lookup: setup.lookup,
        max_open: None,
    });
    Some(Started { pool, statuses, root, _dir: dir })
}

fn with(overrides: &[(LanguageId, &'static str)]) -> Setup {
    Setup { overrides: overrides.to_vec(), ..Default::default() }
}

fn pos(path: &str, line: u64, col: i64) -> LspPosition {
    serde_json::from_value(json!({ "path": path, "line": line, "col": col })).unwrap()
}

fn json_of<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap()
}

const OWNER_HOVER: &str = "```python\ndef f() -> None\n```\n\nDoes the `f` thing.";

#[tokio::test]
async fn starts_a_server_per_language_in_the_diff_and_opens_each_file_in_its_own() {
    let Some(s) = start(with(&[(LanguageId::Python, "py-server"), (LanguageId::Go, "go-server")])) else { return };
    assert!(s.commands().is_empty());
    s.pool.track(&diff(&["a.py", "b.go", "c.txt"])).await;
    s.settle().await;
    assert_eq!(s.events("py-server").unwrap(), ["open a.py v1"]);
    assert_eq!(s.events("go-server").unwrap(), ["open b.go v1"]);
    // A language nothing serves never starts a process; servers come in language order.
    assert_eq!(s.commands(), ["go-server", "py-server"]);
    let res = s.pool.definition(&pos("a.py", 3, 4)).await.unwrap();
    assert_eq!(json_of(&res.locations), json!([{ "path": "a.py", "line": 2, "col": 4, "text": "def f():" }]));
    assert_eq!(
        json_of(&s.pool.hover(&pos("b.go", 2, 5)).await.unwrap()),
        json!({ "contents": OWNER_HOVER, "range": { "line": 2, "col": 4, "endLine": 2, "endCol": 5 } })
    );
    s.pool.close().await;
}

#[tokio::test]
async fn routes_by_extension_and_refuses_a_path_it_cannot_serve() {
    let Some(s) = start(with(&[(LanguageId::Python, "py-server"), (LanguageId::Rust, "")])) else { return };
    s.pool.track(&diff(&["a.py", "main.rs", "main.go"])).await;
    // The route words why through lsp_blocker before asking; the pool only refuses.
    assert!(matches!(s.pool.definition(&pos("c.txt", 1, 0)).await, Err(Error::LspUnavailable(_))));
    assert!(matches!(s.pool.definition(&pos("b.go", 1, 0)).await, Err(Error::LspUnavailable(_))));
    assert!(matches!(s.pool.document_symbols("main.rs").await, Err(Error::LspUnavailable(_))));
    let err = s.pool.document_symbols("main.go").await.unwrap_err();
    assert!(err.to_string().contains("no language server for main.go"), "{err}");
    s.pool.close().await;
}

#[tokio::test]
async fn reports_every_server_and_every_unserved_language_as_one_status() {
    let Some(s) = start(with(&[(LanguageId::Python, "py-server"), (LanguageId::Rust, "")])) else { return };
    s.pool.track(&diff(&["a.py", "main.rs", "b.go"])).await;
    s.settle().await;
    let status = s.pool.status();
    assert!(status.enabled);
    assert_eq!(status.servers.len(), 1);
    let server = &status.servers[0];
    assert_eq!(
        (server.name.as_str(), server.command.as_str(), server.state),
        ("py-server", "py-server", LspState::Ready)
    );
    assert_eq!(server.languages, [LanguageId::Python]);
    assert_eq!(
        json_of(&server.supports),
        json!([
            "definition",
            "typeDefinition",
            "hover",
            "references",
            "documentSymbol",
            "workspaceSymbol",
            "documentHighlight"
        ])
    );
    assert_eq!(
        json_of(&status.missing),
        json!([{ "language": "go", "tried": ["gopls"] }, { "language": "rust", "tried": [] }])
    );
    // Every change, from resolution to readiness, reaches the listener as the whole pool's status.
    let current = json_of(&status);
    eventually("the last status published", || s.statuses.lock().unwrap().last().map(json_of) == Some(current.clone()))
        .await;
    let all_starting =
        |st: &LspStatus| !st.servers.is_empty() && st.servers.iter().all(|x| x.state == LspState::Starting);
    assert!(s.statuses.lock().unwrap().iter().any(all_starting));
    s.pool.close().await;
}

#[tokio::test]
async fn hands_a_language_that_arrives_later_to_the_process_already_running_its_command() {
    let Some(s) = start(with(&[(LanguageId::C, "clangd-ish"), (LanguageId::Cpp, "clangd-ish")])) else { return };
    s.pool.track(&diff(&["x.c"])).await;
    s.pool.track(&diff(&["x.c", "y.cpp"])).await;
    s.settle().await;
    assert_eq!(s.commands(), ["clangd-ish"]);
    let mut opened = s.events("clangd-ish").unwrap();
    opened.sort();
    assert_eq!(opened, ["open x.c v1", "open y.cpp v1"]);
    let server = &s.pool.status().servers[0];
    assert_eq!((server.name.as_str(), server.state), ("clangd-ish", LspState::Ready));
    assert_eq!(server.languages, [LanguageId::C, LanguageId::Cpp]);
    s.pool.close().await;
}

#[tokio::test]
async fn asks_every_server_for_workspace_symbols_and_keeps_a_server_whose_language_left_the_diff() {
    let Some(s) = start(with(&[(LanguageId::Python, "py-server"), (LanguageId::Go, "go-server")])) else { return };
    s.pool.track(&diff(&["a.py", "b.go"])).await;
    let names: Vec<String> = s.pool.workspace_symbols("q").await.unwrap().symbols.into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["q_sym", "q_sym"]);
    // A refresh that drops go keeps its server up, with nothing open.
    s.pool.track(&diff(&["a.py"])).await;
    s.settle().await;
    let servers: Vec<String> = s.pool.status().servers.into_iter().map(|s| s.name).collect();
    assert_eq!(servers, ["go-server", "py-server"]);
    assert_eq!(s.events("go-server").unwrap(), ["open b.go v1", "close b.go"]);
    s.pool.close().await;
}

#[tokio::test]
async fn starts_preloaded_languages_before_any_snapshot_arrives() {
    let setup = Setup { preload: vec![LanguageId::Python], ..with(&[(LanguageId::Python, "py-server")]) };
    let Some(s) = start(setup) else { return };
    assert_eq!(s.commands(), ["py-server"]);
    let states: Vec<LspState> = s.pool.status().servers.into_iter().map(|s| s.state).collect();
    assert_eq!(states, [LspState::Starting]);
    assert!(s.pool.hover(&pos("a.py", 2, 4)).await.unwrap().contents.unwrap().contains("def f()"));
    s.pool.close().await;
}

#[tokio::test]
async fn names_rust_analyzer_the_cargo_workspaces_the_diff_reaches_again_as_it_reaches_more() {
    let setup = Setup {
        on_disk: Some(vec![
            ("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n"),
            ("crates/a/Cargo.toml", "[package]\nname = \"a\"\n"),
            ("py-rattler/Cargo.toml", "[package]\nname = \"py-rattler\"\n[workspace]\n"),
        ]),
        ..with(&[(LanguageId::Rust, "rust-analyzer")])
    };
    let Some(s) = start(setup) else { return };
    let root = s.root.clone();
    let linked = |manifests: &[&str]| json!({ "linkedProjects": manifests.iter().map(|m| root.join(m).to_string_lossy().into_owned()).collect::<Vec<_>>() });
    let configs = || {
        s.events("rust-analyzer")
            .unwrap_or_default()
            .into_iter()
            .filter(|l| l.starts_with("config "))
            .collect::<Vec<_>>()
    };
    let config = |manifests: &[&str]| format!("config {}", json!({ "rust-analyzer": linked(manifests) }));
    s.pool.track(&diff(&["crates/a/src/lib.rs"])).await;
    let first = vec![config(&["Cargo.toml"])];
    eventually("the first config", || configs() == first).await;
    let init = format!("init {}", linked(&["Cargo.toml"]));
    assert!(s.events("rust-analyzer").unwrap().contains(&init));
    assert_eq!(
        json_of(&s.pool.status().servers[0].projects),
        json!({ "label": "Cargo workspaces", "paths": ["Cargo.toml"] })
    );
    // Another file of a workspace already named changes nothing; one of a new workspace reloads.
    s.pool.track(&diff(&["crates/a/src/lib.rs", "crates/a/src/main.rs"])).await;
    s.pool.track(&diff(&["py-rattler/src/lib.rs"])).await;
    let both = vec![config(&["Cargo.toml"]), config(&["Cargo.toml", "py-rattler/Cargo.toml"])];
    eventually("the second config", || configs() == both).await;
    // The status follows, and reaches the client as one.
    let shown = json!({ "label": "Cargo workspaces", "paths": ["Cargo.toml", "py-rattler/Cargo.toml"] });
    eventually("the projects in the status", || {
        s.statuses.lock().unwrap().last().and_then(|st| st.servers.first().map(|x| json_of(&x.projects)))
            == Some(shown.clone())
    })
    .await;
    s.pool.close().await;
}

/// PATH holds Tailwind alone; the tagged fake stands in for it, and `env` tunes one command's fake.
fn overlay(
    overrides: &[(LanguageId, &'static str)],
    env: Vec<(&'static str, Vec<(&'static str, &'static str)>)>,
) -> Option<Started> {
    let mut env = env;
    match env.iter_mut().find(|(c, _)| *c == TAILWIND) {
        Some((_, vars)) => vars.push(("FAKE_LSP_TAG", "tailwind")),
        None => env.push((TAILWIND, vec![("FAKE_LSP_TAG", "tailwind")])),
    }
    let lookup: Lookup = Arc::new(|c: &str| {
        c.starts_with("tailwindcss-language-server").then(|| PathBuf::from("/usr/bin/tailwindcss-language-server"))
    });
    start(Setup { lookup, env, ..with(overrides) })
}

#[tokio::test]
async fn starts_for_a_joined_language_and_merges_its_hovers_and_locations_after_the_owners() {
    let Some(s) = overlay(&[(LanguageId::Typescriptreact, "ts-server")], Vec::new()) else { return };
    s.pool.track(&diff(&["a.tsx"])).await;
    let routes = |st: &LspStatus| {
        st.servers.iter().map(|x| (x.command.clone(), json_of(&x.languages), json_of(&x.joins))).collect::<Vec<_>>()
    };
    assert_eq!(
        routes(&s.pool.status()),
        [
            ("ts-server".to_owned(), json!(["typescriptreact"]), json!([])),
            (TAILWIND.to_owned(), json!([]), json!(["typescriptreact"])),
        ]
    );
    assert_eq!(
        json_of(&s.pool.hover(&pos("a.tsx", 2, 0)).await.unwrap()),
        json!({ "contents": format!("{OWNER_HOVER}\n\n---\n\ntailwind says hi"), "range": { "line": 2, "col": 4, "endLine": 2, "endCol": 5 } })
    );
    assert_eq!(
        json_of(&s.pool.definition(&pos("a.tsx", 2, 0)).await.unwrap().locations),
        json!([
            { "path": "a.tsx", "line": 2, "col": 4, "text": "f;" },
            { "path": "a.tsx", "line": 5, "col": 0, "text": "export {};" },
        ])
    );
    // Highlights come from the owner alone: the joined fake would double them.
    assert_eq!(s.pool.occurrences(&pos("a.tsx", 2, 0)).await.unwrap().occurrences.len(), 1);
    // A language entering the diff later joins the running process, as an owner's would.
    s.pool.track(&diff(&["a.tsx", "b.js"])).await;
    let joins: Vec<(String, Value)> =
        s.pool.status().servers.iter().map(|x| (x.command.clone(), json_of(&x.joins))).collect();
    assert_eq!(
        joins,
        [("ts-server".to_owned(), json!([])), (TAILWIND.to_owned(), json!(["typescriptreact", "javascript"]))]
    );
    s.pool.close().await;
}

#[tokio::test]
async fn serves_a_language_nothing_owns_by_itself() {
    let Some(s) = overlay(&[], Vec::new()) else { return };
    s.pool.track(&diff(&["b.js"])).await;
    let status = s.pool.status();
    assert_eq!(status.servers.iter().map(|x| x.command.as_str()).collect::<Vec<_>>(), [TAILWIND]);
    assert_eq!(
        json_of(&status.missing),
        json!([{ "language": "javascript", "tried": ["typescript-language-server", "vtsls"] }])
    );
    assert_eq!(json_of(&s.pool.hover(&pos("b.js", 2, 0)).await.unwrap()), json!({ "contents": "tailwind says hi" }));
    assert_eq!(s.pool.occurrences(&pos("b.js", 2, 0)).await.unwrap().occurrences.len(), 1);
    s.pool.close().await;
}

#[tokio::test]
async fn keeps_the_owners_answer_when_the_joined_server_is_gone_and_the_owners_error_when_nothing_answers() {
    let Some(s) = overlay(&[(LanguageId::Typescriptreact, "ts-server")], vec![(TAILWIND, vec![("FAKE_LSP_DIE", "1")])])
    else {
        return;
    };
    s.pool.track(&diff(&["a.tsx"])).await;
    eventually("the joined server gone", || {
        s.pool.status().servers.get(1).map(|x| x.state) == Some(LspState::Unavailable)
    })
    .await;
    assert_eq!(
        json_of(&s.pool.hover(&pos("a.tsx", 2, 0)).await.unwrap()),
        json!({ "contents": OWNER_HOVER, "range": { "line": 2, "col": 4, "endLine": 2, "endCol": 5 } })
    );
    s.pool.close().await;

    let Some(dead) =
        overlay(&[(LanguageId::Typescriptreact, "ts-server")], vec![("ts-server", vec![("FAKE_LSP_DIE", "1")])])
    else {
        return;
    };
    dead.pool.track(&diff(&["a.tsx"])).await;
    eventually("the owner gone", || dead.pool.status().servers.first().map(|x| x.state) == Some(LspState::Unavailable))
        .await;
    assert_eq!(
        json_of(&dead.pool.hover(&pos("a.tsx", 2, 0)).await.unwrap()),
        json!({ "contents": "tailwind says hi" })
    );
    // Line 1 has no hover anywhere, so the owner's outage is why the answer may be incomplete.
    let empty = dead.pool.hover(&pos("a.tsx", 1, 0)).await.unwrap();
    assert_eq!(empty.contents, None);
    let reason = empty.inconclusive.unwrap();
    assert!(reason.contains("\"ts-server\" exited"), "{reason}");
    dead.pool.close().await;
}

#[tokio::test]
async fn tracks_nothing_when_the_new_side_is_not_the_checkout() {
    let Some(s) = start(with(&[(LanguageId::Python, "py-server")])) else { return };
    s.pool.track(&diff_at(&["a.py"], "abc123", "def456")).await;
    s.settle().await;
    assert!(s.commands().is_empty());
    s.pool.track(&diff_at(&["a.py"], "abc123", "abc123")).await;
    s.settle().await;
    assert_eq!(s.events("py-server").unwrap(), ["open a.py v1"]);
    s.pool.close().await;
}

#[tokio::test]
async fn hands_out_one_servers_log_by_command() {
    let Some(s) = start(with(&[(LanguageId::Python, "py-server")])) else { return };
    s.pool.track(&diff(&["a.py"])).await;
    let opened = || s.pool.log("py-server").is_some_and(|log| log.iter().any(|e| e.message == "open a.py v1"));
    eventually("the open line", opened).await;
    assert!(s.pool.log("go-server").is_none());
    s.pool.close().await;
}

#[tokio::test]
async fn has_nothing_to_say_once_closed() {
    let setup = Setup { preload: vec![LanguageId::Python], ..with(&[(LanguageId::Python, "py-server")]) };
    let Some(s) = start(setup) else { return };
    s.pool.close().await;
    let seen = s.statuses.lock().unwrap().len();
    s.pool.track(&diff(&["a.py"])).await;
    assert_eq!(s.statuses.lock().unwrap().len(), seen);
    let err = s.pool.definition(&pos("a.py", 1, 0)).await.unwrap_err();
    assert!(err.to_string().contains("shutting down"), "{err}");
}
