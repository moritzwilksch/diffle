//! One language server process against the fake server in `test/lsp`, run with `node`.
#![cfg(unix)]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::FutureExt;
use serde_json::{Value, json};

use diffle::lsp::process::{LspProcess, ProcessOptions, SettingsFuture};
use diffle::protocol::{LspFeature, LspProcessStatus, LspState};

fn fake() -> Option<String> {
    let node = diffle::lsp::which::find_on_path("node");
    if node.is_none() {
        eprintln!("node is not on PATH; skipping the fake language server tests");
    }
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/lsp/fake-lsp.mjs");
    node.map(|_| format!("node '{}'", dunce::canonicalize(&script).unwrap().display()))
}

struct Started {
    process: Arc<LspProcess>,
    statuses: Arc<Mutex<Vec<LspProcessStatus>>>,
    _root: tempfile::TempDir,
}

fn settings(v: Value) -> SettingsFuture {
    async move { v }.boxed().shared()
}

/// Starts the fake under `prefix`, shell text in front of it: an environment assignment, or a
/// command to run first. diffle spawns no shell, so the prefix lives in a wrapper script of the test's.
fn start(prefix: &str, settings: Option<SettingsFuture>, init: Option<Value>) -> Option<Started> {
    let fake = fake()?;
    let root = tempfile::tempdir().unwrap();
    let wrapper = root.path().join("server");
    std::fs::write(&wrapper, format!("#!/bin/sh\n{prefix} {fake}\n")).unwrap();
    std::fs::set_permissions(&wrapper, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let command = wrapper.display().to_string();
    let statuses = Arc::new(Mutex::new(Vec::new()));
    let record = statuses.clone();
    let process = LspProcess::start(ProcessOptions {
        command,
        root: root.path().to_path_buf(),
        settings,
        initialization_options: init,
        on_status: Arc::new(move |s| record.lock().unwrap().push(s.clone())),
    });
    Some(Started { process, statuses, _root: root })
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn logged(p: &LspProcess) -> Vec<String> {
    p.entries().into_iter().map(|e| e.message).collect()
}

#[tokio::test]
async fn initializes_and_reads_the_advertised_features() {
    let Some(s) = start("FAKE_LSP_OFFERS=definition,hover", None, Some(json!({ "x": 1 }))) else { return };
    let rpc = s.process.connection().await.unwrap();
    assert_eq!(s.process.status().state, LspState::Ready);
    assert_eq!(s.process.name(), "server");
    assert!(s.process.supports(LspFeature::Definition) && s.process.supports(LspFeature::Hover));
    assert!(!s.process.supports(LspFeature::References));
    eventually("the init log", || logged(&s.process).contains(&r#"init {"x":1}"#.to_owned())).await;
    assert_eq!(
        rpc.request(
            "textDocument/hover",
            json!({ "textDocument": { "uri": "file:///a" }, "position": { "line": 0, "character": 0 } }),
            None
        )
        .await
        .unwrap(),
        Value::Null
    );
    s.process.close().await;
}

#[tokio::test]
async fn takes_a_registered_feature_until_it_is_unregistered() {
    let Some(s) = start("FAKE_LSP_REGISTERS=references", None, None) else { return };
    let rpc = s.process.connection().await.unwrap();
    eventually("the registration", || s.process.supports(LspFeature::References)).await;
    let params = json!({ "unregisterations": [{ "id": "reg-references", "method": "textDocument/references" }] });
    rpc.notify("test/request", json!({ "method": "client/unregisterCapability", "params": params }));
    eventually("the unregistration", || !s.process.supports(LspFeature::References)).await;
    assert!(s.process.supports(LspFeature::Definition));
    s.process.close().await;
}

#[tokio::test]
async fn sends_settings_once_initialized_and_again_only_when_they_change() {
    let Some(s) = start("", Some(settings(json!({ "yaml": { "hover": true } }))), None) else { return };
    let rpc = s.process.connection().await.unwrap();
    eventually("the settings", || logged(&s.process).contains(&r#"config {"yaml":{"hover":true}}"#.to_owned())).await;
    s.process.reconfigure(settings(json!({ "yaml": { "hover": true } })));
    s.process.reconfigure(settings(json!({ "yaml": { "hover": false } })));
    eventually("the new settings", || logged(&s.process).contains(&r#"config {"yaml":{"hover":false}}"#.to_owned()))
        .await;
    // The repeat of the first settings was superseded before it was sent, and nothing went twice.
    rpc.notify("test/mark", json!({ "mark": "settled" }));
    eventually("the mark", || logged(&s.process).contains(&"settled".to_owned())).await;
    assert_eq!(logged(&s.process).iter().filter(|l| l.starts_with("config ")).count(), 2);
    s.process.close().await;
}

#[tokio::test]
async fn reports_unavailable_when_the_server_dies_during_initialize() {
    let Some(s) = start("FAKE_LSP_DIE=1", None, None) else { return };
    let err = s.process.connection().await.err().unwrap();
    assert!(matches!(err, diffle::error::Error::LspUnavailable(_)), "{err}");
    let status = s.process.status();
    assert_eq!(status.state, LspState::Unavailable);
    let message = status.message.unwrap();
    assert!(message.starts_with('"') && message.ends_with("\" exited (3)"), "{message}");
    assert_eq!(s.statuses.lock().unwrap().last().unwrap().state, LspState::Unavailable);
    s.process.close().await;
}

#[tokio::test]
async fn files_messages_stderr_and_progress_and_lets_shown_problems_stand_as_the_notice() {
    let Some(s) = start("", None, None) else { return };
    let rpc = s.process.connection().await.unwrap();
    let tell =
        |method: &str, params: Value| rpc.notify("test/notification", json!({ "method": method, "params": params }));
    tell("window/logMessage", json!({ "type": 2, "message": "languageId not found" }));
    tell("window/logMessage", json!({ "type": 2, "message": "languageId not found" }));
    tell("window/showMessage", json!({ "type": 3, "message": "Indexing done" }));
    tell("window/showMessage", json!({ "type": 2, "message": "Could not find Astro" }));
    tell("$/progress", json!({ "token": "load", "value": { "kind": "begin", "title": "Loading workspace" } }));
    eventually("the notice", || s.process.status().notice.is_some_and(|n| n.message == "Could not find Astro")).await;
    eventually("the activity", || !s.process.status().activity.is_empty()).await;
    assert_eq!(s.process.busy().as_deref(), Some("server is busy: Loading workspace; try again when it finishes"));
    rpc.notify("test/mark", json!({ "mark": "a line on stderr" }));
    eventually("the stderr line", || logged(&s.process).contains(&"a line on stderr".to_owned())).await;
    let entries = s.process.entries();
    let repeated = entries.iter().find(|e| e.message == "languageId not found").unwrap();
    assert_eq!(repeated.count.get(), 2);
    let log = s.process.status().log;
    assert_eq!((log.warnings, log.errors), (3, 0));
    tell("$/progress", json!({ "token": "load", "value": { "kind": "end" } }));
    eventually("the end of the work", || s.process.busy().is_none()).await;
    s.process.close().await;
}

/// Whether a process with `pid` still runs.
fn alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[tokio::test]
async fn close_reaps_the_whole_process_group() {
    // A sleep beside the server, in its group: the server's own exit leaves it, a group signal does not.
    let pidfile = tempfile::NamedTempFile::new().unwrap();
    let env = format!("sleep 300 & echo $! > '{}'; exec", pidfile.path().display());
    let Some(s) = start(&env, None, None) else { return };
    s.process.connection().await.unwrap();
    let pid: i32 = std::fs::read_to_string(pidfile.path()).unwrap().trim().parse().unwrap();
    assert!(alive(pid));
    s.process.close().await;
    eventually("the group to go", || !alive(pid)).await;
}
