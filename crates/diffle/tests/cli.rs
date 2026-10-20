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
    cmd.args(args).env("NO_COLOR", "1").env("XDG_CONFIG_HOME", config).env("GIT_CONFIG_GLOBAL", null_device());
    cmd
}

fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
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

/// Compares `text` with the committed snapshot, or writes it when missing or under UPDATE_SNAPSHOTS=1.
fn snapshot(name: &str, text: &str) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots").join(name);
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() || !file.exists() {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, text).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&file).unwrap().replace("\r\n", "\n");
    assert_eq!(text, committed, "{name} differs; rerun with UPDATE_SNAPSHOTS=1 to accept");
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
    snapshot("help.txt", &main);
    let sections: Vec<String> = ["working", "pr", "range-diff", "config"]
        .iter()
        .map(|cmd| format!("$ diffle {cmd} --help\n\n{}", help(&[cmd])))
        .collect();
    snapshot("help-commands.txt", &sections.join("\n"));
}

#[test]
fn usage_errors_name_what_was_wrong_and_exit_2() {
    let config = tempfile::tempdir().unwrap();
    let cases: [(&[&str], &str); 4] = [
        (&["config", "unset-lsp", "python", "nope"], "unknown language \"nope\""),
        (&["working", "--no-open", "--no-watch", "--lsp", "python=x", "--lsp"], "--lsp <language=command>"),
        (&["working", "--no-open", "--no-watch", "--lsp", "nope=x"], "unknown language \"nope\""),
        (&["--port", "65536"], "expected an integer between 0 and 65535"),
    ];
    for (args, message) in cases {
        let out = run(config.path(), args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(stderr(&out).contains(message), "{args:?}: {}", stderr(&out));
    }
}

#[test]
fn config_sets_one_language_at_a_time_and_unsets_every_language_it_is_given() {
    let config = tempfile::tempdir().unwrap();
    run(config.path(), &["config", "set-lsp", "python", "my-py-server"]);
    let both = run(config.path(), &["config", "set-lsp", "go", "my-go-server"]);
    assert_eq!(stdout(&both), "go=my-go-server\npython=my-py-server\n");
    assert_eq!(stdout(&run(config.path(), &["config", "unset-lsp", "python", "go"])), "");
    let file = std::fs::read_to_string(config.path().join("diffle/config.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&file).unwrap();
    assert_eq!(json["lspCommands"], serde_json::json!({}));
    assert_eq!(stdout(&run(config.path(), &["config", "set-context", "7"])), "7\n");
    assert_eq!(
        stdout(&run(config.path(), &["config", "add-auto-viewed", "*.lock", "*.snap", "*.lock"])),
        "*.lock\n*.snap\n"
    );
    assert_eq!(stdout(&run(config.path(), &["config", "remove-auto-viewed", "*.lock"])), "*.snap\n");
    let shown = stdout(&run(config.path(), &["config"]));
    assert!(shown.starts_with("# ") && shown.contains("\"contextLines\": 7"), "{shown}");
}

#[test]
fn writes_completion_scripts_carrying_the_argument_choices() {
    let config = tempfile::tempdir().unwrap();
    for shell in ["bash", "zsh", "fish"] {
        let script = stdout(&run(config.path(), &["completion", "--shell", shell]));
        // The shorthands are hidden commands; the revision argument's choices offer them anyway.
        assert!(script.contains("working"), "{shell}");
        // Languages are a static choice list, so they complete without a config lookup.
        assert!(script.contains("typescriptreact"), "{shell}");
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

/// Starts a review and returns it with its URL once stderr announces it.
// The child goes to the caller, who stops and reaps it.
#[allow(clippy::zombie_processes)]
fn serve(config: &Path, repo: &Path) -> (Child, String, BufReader<std::process::ChildStderr>) {
    let mut child =
        diffle(config, &["--no-open", "--no-watch", "--no-lsp", "-C", repo.to_str().unwrap(), "--port", "0"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        if lines.read_line(&mut line).unwrap() == 0 {
            let _ = child.wait();
            panic!("diffle exited before serving");
        }
        if let Some(url) = line.trim().strip_prefix("🚀 diffle running at ") {
            return (child, url.to_owned(), lines);
        }
    }
}

/// One HTTP/1.1 request on its own connection; returns the status line and body.
fn http(url: &str, method: &str, path: &str, body: &str) -> (String, String) {
    let authority = url.trim_start_matches("http://").trim_end_matches('/');
    let mut stream = TcpStream::connect(authority).unwrap();
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
    let (mut child, url, mut lines) = serve(config.path(), &t.path);
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
