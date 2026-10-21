//! The fake language server (`test/lsp/fake-lsp.mjs`), run with `node` under real commands.
//!
//! A shared bin directory, prepended to PATH once per test binary, holds one wrapper per command the
//! tests name (`fake`, `py-server`, ...). Each runs the fake with its working directory, the server's
//! root, as `FAKE_LSP_ROOT`, after sourcing `<root>/.fake-env` and `<root>/.fake-env-<command>`.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::json;

use diffle::lsp::process::LspProcess;

/// The commands the wrappers answer to.
const COMMANDS: [&str; 7] =
    ["fake", "py-server", "go-server", "clangd-ish", "ts-server", "rust-analyzer", "tailwindcss-language-server"];

static BIN: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Puts the wrappers first on PATH; none when `node` is missing, and the caller skips.
pub fn fake_servers() -> Option<&'static Path> {
    BIN.get_or_init(|| {
        diffle::lsp::which::find_on_path("node").or_else(|| {
            eprintln!("node is not on PATH; skipping the fake language server tests");
            None
        })?;
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/lsp/fake-lsp.mjs");
        let script = dunce::canonicalize(script).unwrap();
        let dir = tempfile::tempdir().unwrap().keep();
        for name in COMMANDS {
            let wrapper = format!(
                "#!/bin/sh\nexport FAKE_LSP_ROOT=\"$(pwd -P)\"\n[ -f ./.fake-env ] && . ./.fake-env\n[ -f './.fake-env-{name}' ] && . './.fake-env-{name}'\nexec node '{}'\n",
                script.display()
            );
            let path = dir.join(name);
            std::fs::write(&path, wrapper).unwrap();
            std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        }
        let path = std::env::var("PATH").unwrap_or_default();
        // Set once, before any test of this binary spawns: every caller waits on this lock first.
        unsafe { std::env::set_var("PATH", format!("{}:{path}", dir.display())) };
        Some(dir)
    })
    .as_deref()
}

/// Writes the environment the fake reads in `root`: for every command, or for one when `command` is given.
pub fn fake_env(root: &Path, command: Option<&str>, vars: &[(&str, &str)]) {
    let file = root.join(command.map_or_else(|| ".fake-env".to_owned(), |c| format!(".fake-env-{c}")));
    let lines: String = vars.iter().map(|(k, v)| format!("export {k}='{v}'\n")).collect();
    std::fs::write(file, lines).unwrap();
}

/// The fake's stderr lines in order, repeats unfolded: its document events and what it logged.
pub fn events(process: &LspProcess) -> Vec<String> {
    let entries = process.entries().into_iter().filter(|e| e.source == diffle::protocol::LspLogSource::Stderr);
    entries
        .flat_map(|e| std::iter::repeat_n(e.message, e.count.get() as usize))
        .filter(|m| !m.starts_with("mark "))
        .collect()
}

/// Waits until the fake has logged everything sent to it before the call, so a test can assert both
/// what arrived and what did not. Notifications have no reply to await.
pub async fn flush(process: &LspProcess) {
    static MARKS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let Ok(rpc) = process.connection().await else { return };
    let mark = format!("mark {}", MARKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    rpc.notify("test/mark", json!({ "mark": mark }));
    eventually(&mark, || process.entries().iter().any(|e| e.message == mark)).await;
}

/// Sends the fake a notification to pass on to the client as if it were its own.
pub async fn tell(process: &LspProcess, method: &str, params: serde_json::Value) {
    let rpc = process.connection().await.unwrap();
    rpc.notify("test/notification", json!({ "method": method, "params": params }));
}

/// Has the fake send the client a request of its own.
pub async fn ask(process: &LspProcess, method: &str, params: serde_json::Value) {
    let rpc = process.connection().await.unwrap();
    rpc.notify("test/request", json!({ "method": method, "params": params }));
}

pub async fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A canonical temporary directory to serve as a server's root.
pub fn root() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dunce::canonicalize(dir.path()).unwrap();
    (dir, path)
}
