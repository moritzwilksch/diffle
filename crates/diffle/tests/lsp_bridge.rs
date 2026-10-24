//! One language server as diffle asks it, against the fake server in `test/lsp`.
#![cfg(unix)]
mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use serde_json::{Value, json};

use common::lsp::{ask, events, eventually, fake_env, fake_servers, flush, root, tell};
use diffle::error::Error;
use diffle::lsp::bridge::{BridgeOptions, LspBridge};
use diffle::lsp::process::ProcessOptions;
use diffle::protocol::{LspFeature, LspPosition, LspProcessStatus, LspState};

type Files = Arc<Mutex<HashMap<String, String>>>;

fn files() -> Files {
    let all = [
        ("a.py", "import os\ndef f():\n    pass\n"),
        ("other.py", "x = 1\ny = 2\nz = f()\n"),
        ("w.py", "w\n"),
        ("x.py", "x\n"),
        ("y.py", "y\n"),
        ("z.py", "z\n"),
    ];
    Arc::new(Mutex::new(all.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()))
}

struct Started {
    bridge: LspBridge,
    statuses: Arc<Mutex<Vec<LspProcessStatus>>>,
    /// Paths `read` was asked for.
    reads: Arc<Mutex<Vec<String>>>,
    files: Files,
    root: PathBuf,
    _dir: Option<tempfile::TempDir>,
}

impl Started {
    /// The document events the fake logged: `open a.py v1`, `change a.py v2`, `close a.py`.
    fn events(&self) -> Vec<String> {
        events(self.bridge.process())
    }

    async fn settle(&self) {
        flush(self.bridge.process()).await;
    }

    fn set(&self, path: &str, text: &str) {
        self.files.lock().unwrap().insert(path.into(), text.into());
    }
}

/// A bridge to `fake` over a fresh root; `env` tunes the fake, `max_open` caps untracked documents.
fn start(env: &[(&str, &str)]) -> Option<Started> {
    start_with(env, None, None, None)
}

fn start_with(
    env: &[(&str, &str)],
    at: Option<PathBuf>,
    max_open: Option<usize>,
    init: Option<Value>,
) -> Option<Started> {
    fake_servers()?;
    let (dir, root) = match at {
        Some(path) => (None, path),
        None => {
            let (dir, path) = root();
            (Some(dir), path)
        }
    };
    // Nothing outside the root on disk unless a test names one.
    let mut env = env.to_vec();
    if !env.iter().any(|(k, _)| *k == "FAKE_LSP_EXTERNAL") {
        env.push(("FAKE_LSP_EXTERNAL", "/nonexistent/site.py"));
    }
    fake_env(&root, Some("fake"), &env);
    let (files, statuses, reads) = (files(), Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
    let (served, listed, record, asked) = (files.clone(), files.clone(), statuses.clone(), reads.clone());
    let bridge = LspBridge::new(BridgeOptions {
        process: ProcessOptions {
            command: "fake".into(),
            root: root.clone(),
            settings: None,
            initialization_options: init,
            on_status: Arc::new(move |s| record.lock().unwrap().push(s.clone())),
        },
        read: Arc::new(move |p| {
            asked.lock().unwrap().push(p.clone());
            let text = served.lock().unwrap().get(&p).cloned();
            async move {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                text
            }
            .boxed()
        }),
        has: Arc::new(move |p| {
            let found = listed.lock().unwrap().contains_key(&p);
            async move { found }.boxed()
        }),
        max_open,
    });
    Some(Started { bridge, statuses, reads, files, root, _dir: dir })
}

fn pos(path: &str, line: u64, col: i64) -> LspPosition {
    serde_json::from_value(json!({ "path": path, "line": line, "col": col })).unwrap()
}

fn json_of<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap()
}

#[tokio::test]
async fn maps_definitions_to_snapshot_paths_and_drops_results_it_can_read_nowhere() {
    let Some(s) = start(&[]) else { return };
    let res = s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    // The fake also points at a file outside the root, which is neither in the snapshot nor on disk.
    assert_eq!(json_of(&res), json!({ "locations": [{ "path": "a.py", "line": 2, "col": 4, "text": "def f():" }] }));
    let states: Vec<LspState> = s.statuses.lock().unwrap().iter().map(|s| s.state).collect();
    assert!(states.iter().all(|st| *st == LspState::Ready), "{states:?}");
    assert_eq!(s.bridge.status().state, LspState::Ready);
    s.bridge.close().await;
}

#[tokio::test]
async fn serves_a_file_outside_the_root_from_disk_once_a_result_named_it_and_nothing_else() {
    let (outside, dir) = root();
    let (site, secret) = (dir.join("site.py"), dir.join("secret.py"));
    std::fs::write(&site, "import sys\n").unwrap();
    std::fs::write(&secret, "token = 1\n").unwrap();
    let site_str = site.to_string_lossy().into_owned();
    let Some(s) = start(&[("FAKE_LSP_EXTERNAL", &site_str)]) else { return };
    assert_eq!(s.bridge.read_external(&site_str).await, None);
    let res = s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    assert_eq!(
        json_of(&res.locations),
        json!([
            { "path": "a.py", "line": 2, "col": 4, "text": "def f():" },
            { "path": site_str, "line": 1, "col": 0, "text": "import sys", "external": true },
        ])
    );
    assert_eq!(s.bridge.read_external(&site_str).await.unwrap(), b"import sys\n");
    // A readable file the server never returned stays behind the snapshot allowlist.
    assert_eq!(s.bridge.read_external(&secret.to_string_lossy()).await, None);
    std::fs::remove_file(&site).unwrap();
    assert_eq!(s.bridge.read_external(&site_str).await, None);
    s.bridge.close().await;
    drop(outside);
}

#[tokio::test]
async fn reads_a_file_inside_the_root_that_the_snapshot_hides_from_disk_and_marks_it_external() {
    let Some(s) = start(&[]) else { return };
    std::fs::write(s.root.join("ignored.py"), "VENV = True\n").unwrap();
    let res = s.bridge.references(&pos("a.py", 1, 0)).await.unwrap();
    let ignored = s.root.join("ignored.py").to_string_lossy().into_owned();
    assert_eq!(
        json_of(res.locations.last().unwrap()),
        json!({ "path": ignored, "line": 1, "col": 0, "text": "VENV = True", "external": true })
    );
    assert_eq!(s.bridge.read_external(&ignored).await.unwrap(), b"VENV = True\n");
    s.bridge.close().await;
}

#[tokio::test]
async fn asks_about_a_file_outside_the_root_once_a_result_named_it_opening_it_from_disk_under_its_own_uri() {
    let (outside, dir) = root();
    let (site, next) = (dir.join("site.py"), dir.join("next.py"));
    std::fs::write(&site, "import sys\ndef g():\n    pass\n").unwrap();
    std::fs::write(&next, "def h():\n    pass\n").unwrap();
    let (site_s, next_s) = (site.to_string_lossy().into_owned(), next.to_string_lossy().into_owned());
    let Some(s) = start(&[("FAKE_LSP_EXTERNAL", &site_s), ("FAKE_LSP_EXTERNAL_NEXT", &next_s)]) else { return };
    // Never named: refused before anything reaches the server.
    assert!(matches!(s.bridge.definition(&pos(&site_s, 2, 4)).await, Err(Error::Invalid(_))));
    s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    let res = s.bridge.definition(&pos(&site_s, 2, 4)).await.unwrap();
    assert_eq!(
        json_of(&res.locations),
        json!([
            { "path": site_s, "line": 2, "col": 4, "text": "def g():", "external": true },
            { "path": next_s, "line": 1, "col": 0, "text": "def h():", "external": true },
        ])
    );
    // The file the outside file named is the next origin, and so on.
    assert!(s.bridge.hover(&pos(&next_s, 2, 0)).await.unwrap().contents.is_some());
    s.settle().await;
    let opened: Vec<String> = s.events().into_iter().filter(|e| e.starts_with("open ")).collect();
    assert_eq!(opened, ["open a.py v1", "open site.py v1", "open next.py v1"]);
    // Outside files come from disk, never through the snapshot read.
    assert_eq!(*s.reads.lock().unwrap(), ["a.py"]);
    s.bridge.close().await;
    drop(outside);
}

#[tokio::test]
async fn opens_a_file_once_when_it_is_asked_about_from_outside_and_then_tracked_as_a_snapshot_path() {
    let Some(s) = start(&[]) else { return };
    std::fs::write(s.root.join("ignored.py"), "VENV = True\n").unwrap();
    s.bridge.references(&pos("a.py", 1, 0)).await.unwrap();
    let ignored = s.root.join("ignored.py").to_string_lossy().into_owned();
    s.bridge.hover(&pos(&ignored, 1, 0)).await.unwrap();
    // The file joins the snapshot (no longer ignored): one URI, so one document.
    s.set("ignored.py", "VENV = True\n");
    s.bridge.track(&["ignored.py".to_owned()]).await;
    s.set("ignored.py", "VENV = False\n");
    s.bridge.track(&["ignored.py".to_owned()]).await;
    s.settle().await;
    let about: Vec<String> = s.events().into_iter().filter(|e| e.contains("ignored.py")).collect();
    assert_eq!(about, ["open ignored.py v1", "change ignored.py v2"]);
    s.bridge.close().await;
}

#[tokio::test]
async fn opens_a_file_once_when_the_server_names_it_through_the_real_path_of_a_symlinked_root() {
    let (dir, base) = root();
    let (real, link) = (base.join("real"), base.join("link"));
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("ignored.py"), "VENV = True\n").unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let named = real.join("ignored.py").to_string_lossy().into_owned();
    let Some(s) = start_with(&[("FAKE_LSP_EXTERNAL", &named)], Some(link.clone()), None, None) else { return };
    let res = s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    // The server spelled it through the real path; diffle remembers it through the root it was given.
    let ignored = link.join("ignored.py").to_string_lossy().into_owned();
    assert_eq!(
        json_of(res.locations.last().unwrap()),
        json!({ "path": ignored, "line": 1, "col": 0, "text": "VENV = True", "external": true })
    );
    assert!(s.bridge.origin(&named).is_none());
    s.bridge.hover(&pos(&ignored, 1, 0)).await.unwrap();
    s.set("ignored.py", "VENV = False\n");
    s.bridge.track(&["ignored.py".to_owned()]).await;
    s.settle().await;
    let about: Vec<String> = s.events().into_iter().filter(|e| e.contains("ignored.py")).collect();
    assert_eq!(about, ["open ignored.py v1", "change ignored.py v2"]);
    s.bridge.close().await;
    drop(dir);
}

#[tokio::test]
async fn keeps_a_hidden_file_inside_the_root_external_until_it_joins_the_snapshot_and_then_holds_its_text() {
    let (dir, base) = root();
    std::fs::create_dir(base.join(".venv")).unwrap();
    std::fs::write(base.join(".venv/x.py"), "X = 1\ndef g():\n").unwrap();
    let venv = base.join(".venv/x.py").to_string_lossy().into_owned();
    let Some(s) = start_with(&[("FAKE_LSP_EXTERNAL", &venv)], Some(base.clone()), None, None) else { return };
    s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    // Asked from the hidden file, the server points back into it: still the outside file, not a
    // repository path the snapshot lacks.
    let res = s.bridge.definition(&pos(&venv, 1, 0)).await.unwrap();
    assert_eq!(
        json_of(&res.locations),
        json!([
            { "path": venv, "line": 2, "col": 4, "text": "def g():", "external": true },
            { "path": venv, "line": 1, "col": 0, "text": "X = 1", "external": true },
        ])
    );
    // Once it joins the snapshot with other text, a query through its outside spelling keeps the
    // snapshot's text rather than flipping the one document back to the disk's.
    s.set(".venv/x.py", "X = 2\ndef g():\n");
    s.bridge.track(&[".venv/x.py".to_owned()]).await;
    s.bridge.hover(&pos(&venv, 2, 0)).await.unwrap();
    s.settle().await;
    let about: Vec<String> = s.events().into_iter().filter(|e| e.contains("x.py")).collect();
    assert_eq!(about, ["open x.py v1", "change x.py v2"]);
    s.bridge.close().await;
    drop(dir);
}

#[tokio::test]
async fn maps_document_highlights_to_new_side_occurrences_with_their_kind_and_stays_quiet_without_them() {
    let Some(s) = start(&[]) else { return };
    // The fake marks `z = ` a write and every other `z` in the enclosing block a read; the `z` outside it is out of scope.
    s.set("other.py", "z = 0\ndef g():\n    z = f()\n    print(z, z)\n");
    assert_eq!(
        json_of(&s.bridge.occurrences(&pos("other.py", 3, 4)).await.unwrap()),
        json!({ "occurrences": [
            { "line": 3, "col": 4, "endLine": 3, "endCol": 5, "kind": "write" },
            { "line": 4, "col": 10, "endLine": 4, "endCol": 11, "kind": "read" },
            { "line": 4, "col": 13, "endLine": 4, "endCol": 14, "kind": "read" },
        ] })
    );
    // A position between symbols holds nothing to highlight; neither case is an error.
    assert!(s.bridge.occurrences(&pos("other.py", 3, 5)).await.unwrap().occurrences.is_empty());
    s.bridge.close().await;
    let Some(plain) = start(&[("FAKE_LSP_WITHOUT", "documentHighlight")]) else { return };
    assert!(plain.bridge.occurrences(&pos("other.py", 3, 0)).await.unwrap().occurrences.is_empty());
    assert_eq!(plain.bridge.status().state, LspState::Ready);
    plain.bridge.close().await;
}

#[tokio::test]
async fn shapes_hover_contents_into_markdown_with_the_range_in_snapshot_units_and_null_when_the_server_has_nothing() {
    let Some(s) = start(&[]) else { return };
    assert_eq!(
        json_of(&s.bridge.hover(&pos("a.py", 2, 4)).await.unwrap()),
        json!({
            "contents": "```python\ndef f() -> None\n```\n\nDoes the `f` thing.",
            "range": { "line": 2, "col": 4, "endLine": 2, "endCol": 5 },
        })
    );
    assert_eq!(json_of(&s.bridge.hover(&pos("a.py", 1, 0)).await.unwrap()), json!({ "contents": null }));
    s.bridge.close().await;
}

#[tokio::test]
async fn rewrites_the_hover_texts_file_links_to_in_app_jumps_and_drops_the_ones_outside_the_root() {
    let Some(s) = start(&[("FAKE_LSP_HOVER_LINKS", "1")]) else { return };
    assert_eq!(
        json_of(&s.bridge.hover(&pos("a.py", 2, 4)).await.unwrap()),
        json!({ "contents": "Go to [f](diffle:a.py#L3) or site" })
    );
    s.bridge.close().await;
}

#[tokio::test]
async fn matches_uris_the_server_canonicalized_when_the_root_is_reached_through_a_symlink() {
    let (dir, base) = root();
    let (real, link) = (base.join("real"), base.join("link"));
    std::fs::create_dir(&real).unwrap();
    std::fs::write(real.join("a.py"), "import os\ndef f():\n    pass\n").unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let (real_s, link_s) = (real.to_string_lossy().into_owned(), link.to_string_lossy().into_owned());
    // The wrapper takes the physical directory; this server is told its root by the link.
    let Some(s) =
        start_with(&[("FAKE_LSP_REAL_ROOT", &real_s), ("FAKE_LSP_ROOT", &link_s)], Some(link.clone()), None, None)
    else {
        return;
    };
    let res = s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    assert_eq!(json_of(&res.locations), json!([{ "path": "a.py", "line": 2, "col": 4, "text": "def f():" }]));
    s.bridge.close().await;
    drop(dir);
}

#[tokio::test]
async fn opens_the_document_with_snapshot_text_updates_it_on_change_and_drops_paths_the_snapshot_hides() {
    let Some(s) = start(&[]) else { return };
    let first = s.bridge.references(&pos("a.py", 1, 0)).await.unwrap();
    let rows: Vec<(String, u64, i64)> =
        first.locations.iter().map(|l| (l.path.to_string(), l.line.get(), l.col)).collect();
    let len = "import os\ndef f():\n    pass\n".len() as i64;
    // ignored.py sits in the root but the snapshot does not expose it, and it is not on disk.
    assert_eq!(rows, [("a.py".to_owned(), 1, len), ("other.py".to_owned(), 3, 0)]);
    s.set("a.py", "x\n");
    let second = s.bridge.references(&pos("a.py", 1, 0)).await.unwrap();
    assert_eq!(second.locations[0].col, 2);
    s.bridge.close().await;
}

#[tokio::test]
async fn flattens_hierarchical_document_symbols_and_filters_workspace_symbols_to_the_snapshot() {
    let Some(s) = start(&[]) else { return };
    assert_eq!(
        json_of(&s.bridge.document_symbols("a.py").await.unwrap()),
        json!({ "symbols": [
            { "name": "Foo", "kind": 5, "path": "a.py", "line": 1, "startLine": 1, "endLine": 4, "col": 6 },
            { "name": "bar", "kind": 6, "container": "Foo", "path": "a.py", "line": 2, "startLine": 2, "endLine": 3, "col": 8 },
            { "name": "baz", "kind": 12, "path": "a.py", "line": 6, "startLine": 6, "endLine": 7, "col": 4 },
        ] })
    );
    assert_eq!(
        json_of(&s.bridge.workspace_symbols("q").await.unwrap()),
        json!({ "symbols": [{ "name": "q_sym", "kind": 12, "container": "mod", "path": "other.py", "line": 5, "startLine": 5, "endLine": 5, "col": 2 }] })
    );
    s.bridge.close().await;
}

#[tokio::test]
async fn decides_workspace_symbol_membership_without_reading_files_and_reads_each_reference_file_once() {
    let Some(s) = start(&[]) else { return };
    s.bridge.workspace_symbols("q").await.unwrap();
    assert!(s.reads.lock().unwrap().is_empty());
    // a.py is opened for the query; other.py and ignored.py are read once each.
    s.bridge.references(&pos("a.py", 1, 0)).await.unwrap();
    let mut later: Vec<String> = s.reads.lock().unwrap()[1..].to_vec();
    later.sort();
    assert_eq!(later, ["ignored.py", "other.py"]);
    s.bridge.close().await;
}

#[tokio::test]
async fn tracks_the_snapshot_opens_its_files_resyncs_changed_text_closes_files_that_left_skips_unreadable_ones() {
    let Some(s) = start(&[]) else { return };
    s.bridge.track(&["a.py".into(), "other.py".into(), "gone.py".into()]).await;
    s.settle().await;
    assert_eq!(s.events(), ["open a.py v1", "open other.py v1"]);
    // A query on a tracked file reuses the open document instead of opening it again.
    s.bridge.definition(&pos("a.py", 1, 0)).await.unwrap();
    // Dropped path: didClose. Changed text: one didChange. Same text: nothing.
    s.set("other.py", "x = 2\n");
    s.bridge.track(&["other.py".into()]).await;
    s.settle().await;
    assert_eq!(s.events()[2..], ["close a.py", "change other.py v2"]);
    // The closed file reopens with the current text on the next query.
    s.bridge.references(&pos("a.py", 1, 0)).await.unwrap();
    s.settle().await;
    assert_eq!(s.events()[4..], ["open a.py v1"]);
    s.bridge.close().await;
}

#[tokio::test]
async fn a_track_pass_and_a_query_racing_on_one_file_open_it_once() {
    let Some(s) = start(&[]) else { return };
    let paths = ["a.py".to_owned()];
    let at = pos("a.py", 1, 0);
    let (_, found) = tokio::join!(s.bridge.track(&paths), s.bridge.definition(&at));
    found.unwrap();
    s.settle().await;
    assert_eq!(s.events(), ["open a.py v1"]);
    s.bridge.close().await;
}

#[tokio::test]
async fn closes_the_least_recently_used_untracked_documents_past_the_cap_and_never_a_tracked_one() {
    let (dir, path) = root();
    let Some(s) = start_with(&[], Some(path), Some(2), None) else { return };
    s.bridge.track(&["a.py".into()]).await;
    for p in ["x.py", "y.py", "z.py"] {
        s.bridge.document_symbols(p).await.unwrap();
    }
    s.settle().await;
    assert_eq!(s.events(), ["open a.py v1", "open x.py v1", "open y.py v1", "open z.py v1", "close x.py"]);
    // Touching y.py makes z.py the oldest; a.py is tracked and exempt.
    s.bridge.document_symbols("y.py").await.unwrap();
    s.bridge.document_symbols("w.py").await.unwrap();
    s.settle().await;
    assert_eq!(s.events()[5..], ["open w.py v1", "close z.py"]);
    s.bridge.close().await;
    drop(dir);
}

#[tokio::test]
async fn track_never_fails_a_dead_server_leaves_nothing_tracked_and_queries_still_report_unavailable() {
    let Some(s) = start(&[("FAKE_LSP_DIE", "1")]) else { return };
    s.bridge.track(&["a.py".into()]).await;
    assert!(matches!(s.bridge.references(&pos("a.py", 1, 0)).await, Err(Error::LspUnavailable(_))));
    s.bridge.close().await;
}

#[tokio::test]
async fn tracks_concurrent_standard_progress_and_keeps_documents_synced_until_all_work_finishes() {
    let Some(s) = start(&[]) else { return };
    let p = s.bridge.process().clone();
    let at = pos("a.py", 3, 4);
    let line1 = pos("a.py", 1, 4);
    s.bridge.track(&["a.py".into()]).await;
    tell(&p, "$/progress", json!({ "token": "load", "value": { "kind": "begin", "title": "Loading workspace" } }))
        .await;
    tell(&p, "$/progress", json!({ "token": 2, "value": { "kind": "begin", "title": "Indexing" } })).await;
    eventually("two pieces of work", || s.bridge.status().activity.len() == 2).await;
    assert_eq!(s.bridge.definition(&at).await.unwrap().locations.len(), 1);
    assert!(s.bridge.hover(&line1).await.unwrap().inconclusive.unwrap().contains("Loading workspace"));
    assert!(!s.bridge.references(&at).await.unwrap().locations.is_empty());
    s.bridge.track(&["a.py".into(), "other.py".into()]).await;
    s.settle().await;
    assert!(s.events().contains(&"open other.py v1".to_owned()));

    tell(&p, "$/progress", json!({ "token": "load", "value": { "kind": "end" } })).await;
    tell(
        &p,
        "$/progress",
        json!({ "token": 2, "value": { "kind": "report", "message": "dependencies", "percentage": 40 } }),
    )
    .await;
    eventually("the report", || s.bridge.status().activity == ["Indexing (40%): dependencies"]).await;
    assert!(s.bridge.hover(&line1).await.unwrap().inconclusive.unwrap().contains("Indexing (40%): dependencies"));
    tell(&p, "$/progress", json!({ "token": 2, "value": { "kind": "end" } })).await;
    eventually("idle", || s.bridge.status().activity.is_empty()).await;
    assert_eq!(json_of(&s.bridge.hover(&line1).await.unwrap()), json!({ "contents": null }));
    assert_eq!(s.bridge.definition(&at).await.unwrap().locations.len(), 1);
    s.bridge.close().await;
}

async fn keeps_an_error_as_the_notice_without_killing_a_usable_server(method: &str) {
    let Some(s) = start(&[]) else { return };
    let p = s.bridge.process().clone();
    s.bridge.track(&["a.py".into()]).await;
    tell(&p, method, json!({ "type": 1, "message": "Failed to load workspace" })).await;
    let notice = || s.bridge.status().notice.map(|n| json_of(&n));
    eventually("the notice", || {
        notice() == Some(json!({ "severity": "error", "message": "Failed to load workspace" }))
    })
    .await;
    assert_eq!(s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap().locations.len(), 1);
    // An empty answer is an answer: the notice does not explain it away.
    assert_eq!(json_of(&s.bridge.hover(&pos("a.py", 1, 0)).await.unwrap()), json!({ "contents": null }));
    tell(&p, method, json!({ "type": 3, "message": "An unrelated info message" })).await;
    tell(&p, "$/progress", json!({ "token": 2, "value": [1, 2, 3] })).await;
    // A reply follows the notifications the fake sent before it, on the same stream.
    s.bridge.hover(&pos("a.py", 1, 0)).await.unwrap();
    assert_eq!(s.bridge.status().notice.unwrap().severity.to_string(), "error");
    assert!(s.bridge.status().activity.is_empty());
    s.bridge.close().await;
}

#[tokio::test]
async fn keeps_a_show_message_error_as_the_notice_without_killing_a_usable_server() {
    keeps_an_error_as_the_notice_without_killing_a_usable_server("window/showMessage").await;
}

#[tokio::test]
async fn keeps_a_show_message_request_error_as_the_notice_without_killing_a_usable_server() {
    keeps_an_error_as_the_notice_without_killing_a_usable_server("window/showMessageRequest").await;
}

#[tokio::test]
async fn files_shown_messages_log_messages_and_stderr_in_one_log_and_lets_only_shown_problems_stand_as_the_notice() {
    let Some(s) = start(&[]) else { return };
    let p = s.bridge.process().clone();
    s.bridge.track(&["a.py".into()]).await;
    s.settle().await;
    let before: Vec<u64> = s.bridge.entries().iter().map(|e| e.id.get()).collect();
    tell(&p, "window/logMessage", json!({ "type": 2, "message": "languageId not found for x.mmd" })).await;
    tell(&p, "window/logMessage", json!({ "type": 2, "message": "languageId not found for x.mmd" })).await;
    tell(&p, "window/logMessage", json!({ "type": 1, "message": "Unhandled exception" })).await;
    tell(&p, "window/showMessage", json!({ "type": 3, "message": "Indexing done" })).await;
    tell(&p, "window/showMessage", json!({ "type": 2, "message": "Could not find Astro" })).await;
    let notice = || s.bridge.status().notice.map(|n| json_of(&n));
    eventually("the notice", || notice() == Some(json!({ "severity": "warning", "message": "Could not find Astro" })))
        .await;
    // Log messages never become the notice, and a warning in the log is no reason to doubt an empty answer.
    assert_eq!(json_of(&s.bridge.hover(&pos("a.py", 1, 0)).await.unwrap()), json!({ "contents": null }));
    // The settle mark is a stderr line of its own; the rest is the log, entry for entry.
    let entries: Vec<_> = s.bridge.entries().into_iter().filter(|e| !e.message.starts_with("mark ")).collect();
    let rows: Vec<(String, String, String, u64)> =
        entries.iter().map(|e| (e.source.to_string(), e.level.to_string(), e.message.clone(), e.count.get())).collect();
    let row = |a: &str, b: &str, c: &str, n: u64| (a.to_owned(), b.to_owned(), c.to_owned(), n);
    assert_eq!(
        rows,
        [
            row("stderr", "log", "open a.py v1", 1),
            row("log", "warning", "languageId not found for x.mmd", 2),
            row("log", "error", "Unhandled exception", 1),
            row("message", "info", "Indexing done", 1),
            row("message", "warning", "Could not find Astro", 1),
        ]
    );
    assert_eq!(before.len(), 2, "the open line and the mark come first");
    // Two warnings from the repeated line count once each; the mark is one more log line.
    assert_eq!(json_of(&s.bridge.status().log), json!({ "seq": 7, "errors": 1, "warnings": 3 }));
    s.bridge.close().await;
}

#[tokio::test]
async fn marks_an_empty_answer_inconclusive_when_standard_progress_begins_during_the_request() {
    let Some(s) = start(&[("FAKE_LSP_LOADING_DURING_QUERY", "1")]) else { return };
    let res = s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    assert!(res.locations.is_empty());
    assert!(res.inconclusive.unwrap().contains("Reloading workspace"));
    s.bridge.close().await;
}

#[tokio::test]
async fn hands_initialization_options_to_the_server_with_initialize() {
    let plugins =
        json!({ "plugins": [{ "name": "@vue/typescript-plugin", "location": "/opt/vue", "languages": ["vue"] }] });
    let (dir, path) = root();
    let Some(s) = start_with(&[], Some(path), None, Some(plugins.clone())) else { return };
    s.bridge.track(&["a.py".into()]).await;
    let line = format!("init {plugins}");
    eventually("the init line", || s.events().contains(&line)).await;
    s.bridge.close().await;
    drop(dir);
}

#[tokio::test]
async fn logs_stderr_by_whole_line_while_the_server_remains_alive() {
    let Some(s) = start(&[]) else { return };
    s.bridge.track(&["a.py".into()]).await;
    eventually("the open line", || s.bridge.entries().iter().any(|e| e.message == "open a.py v1")).await;
    assert!(s.bridge.entries().iter().all(|e| e.source.to_string() == "stderr" && e.level.to_string() == "log"));
    assert_eq!(s.bridge.status().state, LspState::Ready);
    assert!(s.bridge.status().log.seq > 0);
    s.bridge.close().await;
}

#[tokio::test]
async fn re_asks_a_request_the_server_refuses_as_stale_and_reports_an_outage_when_it_keeps_refusing() {
    // Two refusals, then the answer: a document change racing a query must not surface as a failure.
    let Some(one) = start(&[("FAKE_LSP_MODIFIED", "2")]) else { return };
    let res = one.bridge.definition(&pos("a.py", 3, 4)).await.unwrap();
    assert_eq!(json_of(&res.locations), json!([{ "path": "a.py", "line": 2, "col": 4, "text": "def f():" }]));
    one.settle().await;
    assert_eq!(one.events().iter().filter(|e| e.starts_with("refused")).count(), 2);
    one.bridge.close().await;

    let Some(many) = start(&[("FAKE_LSP_MODIFIED", "99")]) else { return };
    let err = many.bridge.references(&pos("a.py", 1, 0)).await.unwrap_err();
    assert!(err.to_string().contains("kept changing; try again"), "{err}");
    // Three attempts, then it stops asking; the server is still up for the next query.
    many.settle().await;
    assert_eq!(many.events().iter().filter(|e| e.starts_with("refused")).count(), 3);
    assert_eq!(many.bridge.status().state, LspState::Ready);
    many.bridge.close().await;
}

#[tokio::test]
async fn asks_only_for_what_the_server_advertised_and_says_so_for_the_rest() {
    let Some(s) = start(&[("FAKE_LSP_OFFERS", "hover,documentSymbol")]) else { return };
    assert!(s.bridge.features().is_empty());
    assert!(s.bridge.hover(&pos("a.py", 2, 4)).await.unwrap().contents.unwrap().contains("def f()"));
    let mut features = s.bridge.features();
    features.sort_by_key(|f| f.to_string());
    assert_eq!(features, [LspFeature::DocumentSymbol, LspFeature::Hover]);
    let err = s.bridge.definition(&pos("a.py", 3, 4)).await.unwrap_err();
    assert!(matches!(&err, Error::LspUnsupported(m) if m == "fake offers no go to definition"), "{err}");
    assert!(s.bridge.references(&pos("a.py", 3, 4)).await.unwrap_err().to_string().contains("offers no references"));
    assert!(s.bridge.workspace_symbols("q").await.unwrap_err().to_string().contains("offers no workspace symbols"));
    // Occurrences are advisory: not offered means none, never an error.
    assert!(s.bridge.occurrences(&pos("a.py", 1, 0)).await.unwrap().occurrences.is_empty());
    s.bridge.close().await;
}

#[tokio::test]
async fn takes_a_feature_the_server_registers_after_initialize_until_it_unregisters() {
    let Some(s) = start(&[("FAKE_LSP_REGISTERS", "documentHighlight,references")]) else { return };
    assert!(s.bridge.hover(&pos("a.py", 2, 4)).await.unwrap().contents.unwrap().contains("def f()"));
    eventually("the registration", || s.bridge.features().contains(&LspFeature::DocumentHighlight)).await;
    assert!(s.bridge.features().contains(&LspFeature::References));
    // a.py line 1 is `import os`: the fake highlights the word under the position.
    assert_eq!(s.bridge.occurrences(&pos("a.py", 1, 0)).await.unwrap().occurrences.len(), 1);
    assert!(!s.bridge.references(&pos("a.py", 1, 0)).await.unwrap().locations.is_empty());
    let params = json!({ "unregisterations": [{ "id": "reg-documentHighlight", "method": "x" }] });
    ask(s.bridge.process(), "client/unregisterCapability", params).await;
    eventually("the unregistration", || !s.bridge.features().contains(&LspFeature::DocumentHighlight)).await;
    assert!(s.bridge.occurrences(&pos("a.py", 1, 0)).await.unwrap().occurrences.is_empty());
    assert!(s.bridge.features().contains(&LspFeature::References));
    s.bridge.close().await;
}

#[tokio::test]
async fn reports_unavailable_when_the_server_dies_during_initialize() {
    let Some(s) = start(&[("FAKE_LSP_DIE", "1")]) else { return };
    assert!(matches!(s.bridge.definition(&pos("a.py", 1, 0)).await, Err(Error::LspUnavailable(_))));
    assert_eq!(s.bridge.status().state, LspState::Unavailable);
    let last = s.statuses.lock().unwrap().last().cloned().unwrap();
    let message = last.message.unwrap();
    assert!(message.contains("exited") || message.contains("initialize failed"), "{message}");
    s.bridge.close().await;
}
