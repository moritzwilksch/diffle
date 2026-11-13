//! The built `diffle` binary, as a user runs it.
mod common;

use std::path::Path;
use std::process::Child;

use common::TestRepo;
use common::cli::{http, run, serve, stderr, stdout, version};

#[test]
fn prints_the_bare_version() {
    let config = tempfile::tempdir().unwrap();
    for flag in ["-v", "--version"] {
        let out = run(config.path(), &[flag]);
        assert!(out.status.success());
        assert_eq!(stdout(&out), format!("{}\n", version()));
    }
}

/// `diffle skill`, what an agent learns diffle offers it: the commands and the tour catalog, as a
/// skill whose frontmatter `--no-frontmatter` leaves out.
#[test]
fn prints_the_agent_interface_as_a_skill() {
    let config = tempfile::tempdir().unwrap();
    let out = run(config.path(), &["skill"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let skill = stdout(&out);
    insta::assert_snapshot!("skill", skill);
    let bare = run(config.path(), &["skill", "--no-frontmatter"]);
    assert!(bare.status.success(), "{}", stderr(&bare));
    let body = &skill[skill.find("# diffle\n").unwrap()..];
    assert!(skill.starts_with("---\nname: diffle\n"));
    assert_eq!(stdout(&bare), body);
    let extra = run(config.path(), &["skill", "list"]);
    assert_eq!(extra.status.code(), Some(2), "{}", stderr(&extra));
    assert_eq!(stdout(&extra), "");
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

/// Where a run serving `repo` announces itself.
fn announcement_file(repo: &Path) -> std::path::PathBuf {
    repo.join(".git").join("diffle").join("server.json")
}

/// `child` announced itself as listening at `at`, and `GET /api/server` answered `info` to match.
fn assert_announced(repo: &Path, child: &Child, at: &str, info: &str) {
    let text = std::fs::read_to_string(announcement_file(repo)).unwrap();
    let announced: serde_json::Value = serde_json::from_str(&text).unwrap();
    let instance = announced["instance"].as_str().unwrap();
    assert!(uuid::Uuid::parse_str(instance).is_ok(), "{instance}");
    let expected = serde_json::json!({ "instance": instance, "pid": child.id(), "url": at, "version": version() });
    assert_eq!(announced, expected);
    let expected = serde_json::json!({
        "instance": instance,
        "pid": child.id(),
        "gitDir": repo.join(".git").to_str().unwrap(),
        "version": version(),
    });
    // The label arrives with the review, which may still be resolving; `tests/server.rs` covers it.
    let mut info: serde_json::Value = serde_json::from_str(info).unwrap();
    info.as_object_mut().unwrap().remove("label");
    assert_eq!(info, expected);
}

#[test]
fn refuses_a_second_run_on_the_same_git_dir_while_the_first_serves() {
    let t = one_file_repo();
    let config = tempfile::tempdir().unwrap();
    let (mut first, url, _lines) = serve(config.path(), &t.path, &["--port", "0"]);

    let second = run(config.path(), &["working", "--no-open", "--no-watch", "-C", t.path.to_str().unwrap(), "-p", "0"]);
    assert_eq!(second.status.code(), Some(2), "{}", stderr(&second));
    assert!(stderr(&second).contains(&format!("diffle is already running at {url}")), "{}", stderr(&second));
    assert!(!stderr(&second).contains("🚀"), "{}", stderr(&second));

    let (status, after) = http(&url, "GET", "/api/server", "");
    assert!(status.contains("200"), "{status}");
    assert_announced(&t.path, &first, &url, &after);
    first.kill().unwrap();
    first.wait().unwrap();
}

#[test]
fn fails_with_1_when_it_cannot_announce_itself() {
    let t = one_file_repo();
    let config = tempfile::tempdir().unwrap();
    // A directory where the file goes: nothing can replace it.
    std::fs::create_dir_all(announcement_file(&t.path)).unwrap();
    let out = run(config.path(), &["working", "--no-open", "--no-watch", "-C", t.path.to_str().unwrap(), "-p", "0"]);
    assert_eq!(out.status.code(), Some(1), "{}", stderr(&out));
    assert!(stderr(&out).contains("server.json"), "{}", stderr(&out));
    assert!(!stderr(&out).contains("🚀"), "{}", stderr(&out));
}

#[test]
fn starts_over_a_crashed_runs_announcement() {
    let t = one_file_repo();
    let config = tempfile::tempdir().unwrap();
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let crashed =
        format!(r#"{{"instance":"crashed","pid":1,"url":"http://127.0.0.1:{closed}/","version":"{}"}}"#, version());
    std::fs::create_dir_all(announcement_file(&t.path).parent().unwrap()).unwrap();
    std::fs::write(announcement_file(&t.path), crashed).unwrap();

    let (mut child, url, _lines) = serve(config.path(), &t.path, &["--port", "0"]);
    let (_, info) = http(&url, "GET", "/api/server", "");
    assert_announced(&t.path, &child, &url, &info);
    child.kill().unwrap();
    child.wait().unwrap();
}

/// Runs Windows cannot express: POSIX shell scripts, SIGTERM, and Unix sockets.
#[cfg(unix)]
mod posix {
    use std::io::Read;
    use std::process::{Child, Command};

    use super::common::cli::{diffle, exchange, http, run, serve, stderr};
    use super::{announcement_file, assert_announced, one_file_repo};

    // The fake browser openers are POSIX shell scripts; Windows opens through `cmd /c start`.
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

    // Stopped with SIGTERM, which Windows has no way to send.
    #[test]
    fn reports_the_review_and_hands_off_the_open_comments_on_stdout_when_stopped() {
        let t = one_file_repo();
        t.write("app.py", "x = 1\ny = 2\n");
        let config = tempfile::tempdir().unwrap();
        let (mut child, url, mut lines) = serve(config.path(), &t.path, &["--port", "0"]);
        let (_, info) = http(&url, "GET", "/api/server", "");
        assert_announced(&t.path, &child, &url, &info);
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
        assert!(!announcement_file(&t.path).exists());
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
        let (_, info) = exchange(UnixStream::connect(&socket).unwrap(), "localhost", "GET", "/api/server", "");
        assert_announced(&t.path, &child, &at, &info);

        // A forward (ssh -L) names its own local port in Host.
        let thread = r#"{"path":"app.py","startLine":2,"body":"rename y"}"#;
        let (status, _) =
            exchange(UnixStream::connect(&socket).unwrap(), "localhost:4321", "POST", "/api/threads", thread);
        assert!(status.contains("201"), "{status}");
        let (status, _) = exchange(UnixStream::connect(&socket).unwrap(), "evil.example", "GET", "/api/config", "");
        assert!(status.contains("403"), "{status}");

        // Another repository: this one's run would be refused before it reached the socket.
        let other = one_file_repo();
        let repo = other.path.to_str().unwrap();
        let taken = run(
            config.path(),
            &["--no-open", "--no-watch", "--no-lsp", "-C", repo, "--socket", socket.to_str().unwrap()],
        );
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
        assert!(!announcement_file(&t.path).exists());
    }

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
}
