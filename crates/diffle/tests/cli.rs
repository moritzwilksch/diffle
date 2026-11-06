//! The built `diffle` binary, as a user runs it.
mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};

use common::TestRepo;

/// The binary with its own config directory and no colours, so no real config is touched.
fn diffle(config: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_diffle"));
    cmd.args(args).env("NO_COLOR", "1").env("XDG_CONFIG_HOME", config).env("GIT_CONFIG_GLOBAL", no_global_config());
    cmd
}

/// A global git config that does not exist: git reads none, and every git accepts the path, where
/// conda-forge's on Windows refuses `NUL`.
fn no_global_config() -> std::path::PathBuf {
    std::env::temp_dir().join("diffle-tests-no-global-gitconfig")
}

fn run(config: &Path, args: &[&str]) -> Output {
    diffle(config, args).stdin(Stdio::null()).output().unwrap()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn prints_the_bare_version() {
    let config = tempfile::tempdir().unwrap();
    for flag in ["-v", "--version"] {
        let out = run(config.path(), &[flag]);
        assert!(out.status.success());
        assert_eq!(stdout(&out), format!("{}\n", version()));
    }
}

/// The version the build took from package.json.
fn version() -> String {
    let package = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&package).unwrap();
    json["version"].as_str().unwrap().to_owned()
}

#[test]
fn help_is_the_committed_text_and_keeps_the_shorthands_in_a_section_of_their_own() {
    let config = tempfile::tempdir().unwrap();
    let help = |args: &[&str]| stdout(&run(config.path(), &[args, &["--help"]].concat()));
    let main = help(&[]);
    let commands = &main[main.find("Commands:").unwrap()..main.find("Shorthands").unwrap()];
    for shorthand in ["working", "pr", "range-diff", "show"] {
        assert!(!commands.lines().any(|l| l.trim_start().starts_with(shorthand)), "{shorthand} listed:\n{commands}");
    }
    for shorthand in ["working", "pr [number|url]", "range-diff <ranges...>"] {
        assert!(main[main.find("Shorthands").unwrap()..].contains(shorthand));
    }
    assert!(!main.contains("[default: ]") && !main.contains("--dev"));
    insta::assert_snapshot!("help", main);
    let sections: Vec<String> = ["working", "pr", "range-diff", "config"]
        .iter()
        .map(|cmd| format!("$ diffle {cmd} --help\n\n{}", help(&[cmd])))
        .collect();
    insta::assert_snapshot!("help-commands", sections.join("\n"));
}

#[test]
fn usage_errors_name_what_was_wrong_and_exit_2() {
    let config = tempfile::tempdir().unwrap();
    let cases: [(&[&str], &str); 7] = [
        (&["completion"], "--shell <shell>"),
        (&["completion", "--shell", "nope"], "invalid value 'nope' for '--shell <shell>'"),
        (&["working", "--no-open", "--no-watch", "--lsp", "python=x", "--lsp"], "--lsp <language=command>"),
        (&["working", "--no-open", "--no-watch", "--lsp", "nope=x"], "unknown language \"nope\""),
        (&["--port", "65536"], "expected an integer between 0 and 65535"),
        (&["working", "--socket", "d.sock", "-p", "1"], "--socket replaces --port and --host"),
        // Before the shorthand and after it: the conflict shows only once they merge.
        (&["-H", "::1", "working", "--socket", "d.sock"], "--socket replaces --port and --host"),
    ];
    for (args, message) in cases {
        let out = run(config.path(), args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(stderr(&out).contains(message), "{args:?}: {}", stderr(&out));
    }
}

#[test]
fn config_prints_the_file_path_and_the_settings() {
    let config = tempfile::tempdir().unwrap();
    let out = run(config.path(), &["config"]);
    let path = config.path().join("diffle").join("config.json");
    assert_eq!(stderr(&out).trim_end(), path.display().to_string());
    let shown = stdout(&out);
    assert!(shown.starts_with("{\n") && shown.contains("\"contextLines\": 5"), "{shown}");
    assert!(serde_json::from_str::<serde_json::Value>(&shown).is_ok());
}

#[test]
fn writes_a_completion_script_for_the_shell_named() {
    let config = tempfile::tempdir().unwrap();
    for shell in ["bash", "zsh", "fish", "elvish", "powershell"] {
        let script = stdout(&run(config.path(), &["completion", "--shell", shell]));
        assert!(script.contains("no-open"), "{shell}:\n{script}");
    }
}

fn one_file_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("app.py", "x = 1\n");
    t.commit("base");
    t
}

// The fake browser openers are POSIX shell scripts; Windows opens through `cmd /c start`.
#[cfg(unix)]
#[test]
fn rejects_an_unknown_revision_before_serving_or_opening_a_browser() {
    use std::os::unix::fs::PermissionsExt;
    let t = one_file_repo();
    let config = tempfile::tempdir().unwrap();
    let bin = config.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let opened = config.path().join("opened");
    for opener in ["open", "xdg-open"] {
        let script = bin.join(opener);
        std::fs::write(&script, format!("#!/bin/sh\necho \"$@\" >> \"{}\"\n", opened.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    let repo = t.path.to_str().unwrap();
    let out = diffle(config.path(), &["does-not-exist", "--no-watch", "--no-lsp", "-C", repo, "-p", "0"])
        .env("PATH", path)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(stderr(&out).contains("unknown revision: does-not-exist"), "{}", stderr(&out));
    assert!(!stderr(&out).contains("running at"));
    assert!(!opened.exists());
}

#[test]
fn fails_with_1_when_the_requested_port_is_taken() {
    let t = one_file_repo();
    let config = tempfile::tempdir().unwrap();
    let blocker = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = blocker.local_addr().unwrap().port().to_string();
    let out = run(config.path(), &["working", "--no-open", "--no-watch", "-C", t.path.to_str().unwrap(), "-p", &port]);
    assert_eq!(out.status.code(), Some(1), "{}", stderr(&out));
    assert!(!stderr(&out).contains("running at"));
}

/// Starts a review listening as `listen` says, and returns it with where it listens (the URL, or
/// `unix:<path>`) once stderr announces that and its version.
// The child goes to the caller, who stops and reaps it.
#[allow(clippy::zombie_processes)]
fn serve(config: &Path, repo: &Path, listen: &[&str]) -> (Child, String, BufReader<std::process::ChildStderr>) {
    let args = [&["--no-open", "--no-watch", "--no-lsp", "-C", repo.to_str().unwrap()], listen].concat();
    let mut child =
        diffle(config, &args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    let announcement = format!("🚀 diffle v{} running at ", version());
    loop {
        line.clear();
        if lines.read_line(&mut line).unwrap() == 0 {
            let _ = child.wait();
            panic!("diffle exited before serving");
        }
        if let Some(url) = line.trim().strip_prefix(&announcement) {
            return (child, url.to_owned(), lines);
        }
    }
}

/// One HTTP/1.1 request on its own connection; returns the status line and body.
fn http(url: &str, method: &str, path: &str, body: &str) -> (String, String) {
    let authority = url.trim_start_matches("http://").trim_end_matches('/');
    exchange(TcpStream::connect(authority).unwrap(), authority, method, path, body)
}

/// One HTTP/1.1 request on `stream`, naming `authority` as its Host.
fn exchange(mut stream: impl Read + Write, authority: &str, method: &str, path: &str, body: &str) -> (String, String) {
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    (head.lines().next().unwrap_or_default().to_owned(), body.to_owned())
}

// Stopped with SIGTERM, which Windows has no way to send.
#[cfg(unix)]
#[test]
fn reports_the_review_and_hands_off_the_open_comments_on_stdout_when_stopped() {
    let t = one_file_repo();
    t.write("app.py", "x = 1\ny = 2\n");
    let config = tempfile::tempdir().unwrap();
    let (mut child, url, mut lines) = serve(config.path(), &t.path, &["--port", "0"]);
    let thread = r#"{"path":"app.py","startLine":2,"body":"rename y"}"#;
    let (status, _) = http(&url, "POST", "/api/threads", thread);
    assert!(status.contains("201"), "{status}");
    Command::new("kill").args(["-TERM", &child.id().to_string()]).status().unwrap();
    let mut rest = String::new();
    lines.read_to_string(&mut rest).unwrap();
    let mut prompt = String::new();
    child.stdout.take().unwrap().read_to_string(&mut prompt).unwrap();
    assert!(child.wait().unwrap().success(), "{rest}");
    for part in [
        "🔍 comparing HEAD..worktree",
        "📝 1 changed file  +1 −0",
        "👀 watching the worktree (disabled with --no-watch)",
        "👋 shutting down",
    ] {
        assert!(rest.contains(part), "{part} missing from:\n{rest}");
    }
    assert_eq!(prompt, "app.py:2\n\n> y = 2\n\nrename y\n\n---\n");
}

/// Waits for `child` to exit on its own, killing it after `limit`.
fn exits_within(child: &mut Child, limit: std::time::Duration) -> std::process::ExitStatus {
    let start = std::time::Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            panic!("still running after {limit:?}");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

// Unix sockets: Windows refuses --socket.
#[cfg(unix)]
#[test]
fn serves_a_socket_only_its_user_can_reach_and_ends_with_the_last_tab_through_it() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    let t = one_file_repo();
    t.write("app.py", "x = 1\ny = 2\n");
    let config = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("d.sock");
    let (mut child, at, mut lines) = serve(config.path(), &t.path, &["--socket", socket.to_str().unwrap()]);
    assert_eq!(at, format!("unix:{}", socket.display()));
    assert_eq!(std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777, 0o600);

    // A forward (ssh -L) names its own local port in Host.
    let thread = r#"{"path":"app.py","startLine":2,"body":"rename y"}"#;
    let (status, _) = exchange(UnixStream::connect(&socket).unwrap(), "localhost:4321", "POST", "/api/threads", thread);
    assert!(status.contains("201"), "{status}");
    let (status, _) = exchange(UnixStream::connect(&socket).unwrap(), "evil.example", "GET", "/api/config", "");
    assert!(status.contains("403"), "{status}");

    let repo = t.path.to_str().unwrap();
    let taken =
        run(config.path(), &["--no-open", "--no-watch", "--no-lsp", "-C", repo, "--socket", socket.to_str().unwrap()]);
    assert_eq!(taken.status.code(), Some(1), "{}", stderr(&taken));
    assert!(stderr(&taken).contains("is in use by another server"), "{}", stderr(&taken));

    // No browser opened, yet the tab connected through the socket ends the run when it leaves.
    let tab = UnixStream::connect(&socket).unwrap();
    let (mut ws, _) = tokio_tungstenite::tungstenite::client("ws://localhost:4321/ws", tab).unwrap();
    ws.close(None).unwrap();
    while ws.read().is_ok() {}
    let status = exits_within(&mut child, std::time::Duration::from_secs(20));
    let mut rest = String::new();
    lines.read_to_string(&mut rest).unwrap();
    assert!(status.success(), "{rest}");
    let mut prompt = String::new();
    child.stdout.take().unwrap().read_to_string(&mut prompt).unwrap();
    assert_eq!(prompt, "app.py:2\n\n> y = 2\n\nrename y\n\n---\n");
    assert!(!socket.exists());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "staging left behind");
}

#[cfg(unix)]
#[test]
fn replaces_a_stale_socket_but_never_another_file() {
    let t = one_file_repo();
    let config = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("d.sock");
    let repo = t.path.to_str().unwrap();
    let args = ["--no-open", "--no-watch", "--no-lsp", "-C", repo, "--socket", socket.to_str().unwrap()];

    std::fs::write(&socket, "keep me").unwrap();
    let refused = run(config.path(), &args);
    assert_eq!(refused.status.code(), Some(1), "{}", stderr(&refused));
    assert!(stderr(&refused).contains("exists and is not a socket"), "{}", stderr(&refused));
    assert_eq!(std::fs::read_to_string(&socket).unwrap(), "keep me");

    // A crashed run's socket: the file stays, nothing answers.
    std::fs::remove_file(&socket).unwrap();
    drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
    let (mut child, at, _lines) = serve(config.path(), &t.path, &["--socket", socket.to_str().unwrap()]);
    assert_eq!(at, format!("unix:{}", socket.display()));
    Command::new("kill").args(["-TERM", &child.id().to_string()]).status().unwrap();
    assert!(child.wait().unwrap().success());
    assert!(!socket.exists());
}
