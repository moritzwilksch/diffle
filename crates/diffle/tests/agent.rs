//! `diffle comments`, as an agent runs it beside a review: finding the run, then reading its threads.
mod common;

use std::path::{Path, PathBuf};
use std::process::{Child, Output};

use common::TestRepo;
use common::cli::{http, run, serve, stderr, stdout};
use serde_json::{Value, json};

/// A review served in the background, killed when the test drops it.
struct Served {
    child: Child,
    url: String,
    _config: tempfile::TempDir,
}

impl Served {
    fn start(repo: &Path, listen: &[&str]) -> Self {
        let config = tempfile::tempdir().unwrap();
        let (child, url, _) = serve(config.path(), repo, listen);
        Self { child, url, _config: config }
    }

    /// `GET path` on this run, parsed.
    fn get(&self, path: &str) -> Value {
        serde_json::from_str(&http(&self.url, "GET", path, "").1).unwrap()
    }

    fn instance(&self) -> String {
        self.get("/api/server")["instance"].as_str().unwrap().to_owned()
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("app.py", "x = 1\n");
    t.write("lib.py", "z = 1\n");
    t.commit("base");
    t.write("app.py", "x = 1\ny = 2\n");
    t.write("lib.py", "z = 2\n");
    t
}

/// `diffle comments <args> -C <repo>`.
fn comments(repo: &Path, args: &[&str]) -> Output {
    let config = tempfile::tempdir().unwrap();
    run(config.path(), &[&["comments"], args, &["-C", repo.to_str().unwrap()]].concat())
}

fn json_out(out: &Output) -> Value {
    assert!(out.status.success(), "{}", stderr(out));
    serde_json::from_str(&stdout(out)).unwrap()
}

fn servers_dir(repo: &Path) -> PathBuf {
    repo.join(".git").join("diffle").join("servers")
}

fn announce(repo: &Path, instance: &str, url: &str) -> PathBuf {
    let file = servers_dir(repo).join(format!("{instance}.json"));
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let announcement = json!({ "instance": instance, "pid": 1, "url": url, "version": "0.0.0" });
    std::fs::write(&file, announcement.to_string()).unwrap();
    file
}

fn assert_none_running(out: &Output) {
    assert_eq!(out.status.code(), Some(2), "{}", stderr(out));
    assert!(stderr(out).contains("no diffle is running for this repository"), "{}", stderr(out));
    assert_eq!(stdout(out), "");
}

#[test]
fn deletes_a_crashed_runs_announcement_and_finds_no_diffle() {
    let t = repo();
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", closed.local_addr().unwrap());
    drop(closed);
    let crashed = announce(&t.path, "0a6c3a0e-5b7e-4a39-9a61-1d1f3e0d9c11", &url);
    // A run still writing its announcement stages it beside the real ones.
    let staging = servers_dir(&t.path).join("other.json.123.tmp");
    std::fs::write(&staging, "{").unwrap();

    assert_none_running(&comments(&t.path, &["list"]));
    assert!(!crashed.exists());
    assert!(staging.exists());
}

#[test]
fn deletes_an_announcement_whose_port_another_server_answers() {
    let t = repo();
    let other = repo();
    let foreign = Served::start(&other.path, &["--port", "0"]);
    // The port now belongs to a run for another repository, under the same instance even.
    let reused = announce(&t.path, &foreign.instance(), &foreign.url);

    assert_none_running(&comments(&t.path, &["list"]));
    assert!(!reused.exists());
    assert_eq!(std::fs::read_dir(servers_dir(&other.path)).unwrap().count(), 1);
}

#[test]
fn asks_which_run_when_two_serve_the_repository() {
    let t = repo();
    let working = Served::start(&t.path, &["--port", "0"]);
    let commit = Served::start(&t.path, &["--port", "0", "show", "HEAD"]);

    let out = comments(&t.path, &["list"]);
    assert_eq!(out.status.code(), Some(2), "{}", stderr(&out));
    let message = stderr(&out);
    assert!(message.contains("--server <instance>"), "{message}");
    assert_eq!(working.get("/api/server")["label"], "HEAD..worktree");
    for run in [&working, &commit] {
        let line = format!("  {}  {}  {}", run.instance(), run.url, run.get("/api/server")["label"].as_str().unwrap());
        assert!(message.lines().any(|l| l == line), "{line} in:\n{message}");
    }

    // The runs show different sets, so each key names the run that answered.
    let key = |run: &Served| run.get("/api/snapshot")["commentKey"].clone();
    assert_ne!(key(&working), key(&commit));
    for run in [&working, &commit] {
        let listed = json_out(&comments(&t.path, &["list", "--server", &run.instance()]));
        assert_eq!(listed["commentKey"], key(run));
    }
    let unknown = comments(&t.path, &["list", "--server", "nope"]);
    assert_eq!(unknown.status.code(), Some(2));
    assert!(stderr(&unknown).contains("no diffle nope is running for this repository"), "{}", stderr(&unknown));
}

#[test]
fn lists_the_shown_threads_by_state_and_path() {
    let t = repo();
    let served = Served::start(&t.path, &["--port", "0"]);
    let post = |thread: Value| {
        let (status, body) = http(&served.url, "POST", "/api/threads", &thread.to_string());
        assert!(status.contains("201"), "{status}");
        serde_json::from_str::<Value>(&body).unwrap()[0]["id"].as_str().unwrap().to_owned()
    };
    post(json!({ "path": "app.py", "startLine": 2, "body": "rename y" }));
    let resolved = post(json!({ "path": "lib.py", "startLine": 1, "body": "why 2?" }));
    let (status, _) = http(&served.url, "PUT", &format!("/api/threads/{resolved}/resolved"), r#"{"resolved":true}"#);
    assert!(status.contains("200"), "{status}");
    let key = served.get("/api/snapshot")["commentKey"].clone();
    let bodies = |listed: &Value| -> Vec<String> {
        let threads = listed["threads"].as_array().unwrap();
        threads.iter().map(|t| t["messages"][0]["body"].as_str().unwrap().to_owned()).collect()
    };

    let all = json_out(&comments(&t.path, &["list"]));
    assert_eq!(all.as_object().unwrap().keys().collect::<Vec<_>>(), ["commentKey", "threads"]);
    assert_eq!(all["commentKey"], key);
    assert_eq!(bodies(&all), ["rename y", "why 2?"]);
    assert_eq!(bodies(&json_out(&comments(&t.path, &["list", "--state", "open"]))), ["rename y"]);
    assert_eq!(bodies(&json_out(&comments(&t.path, &["list", "--state", "resolved"]))), ["why 2?"]);
    assert_eq!(bodies(&json_out(&comments(&t.path, &["list", "--path", "lib.py"]))), ["why 2?"]);
}

#[cfg(unix)]
#[test]
fn reaches_a_run_on_a_unix_socket() {
    let t = repo();
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("diffle.sock");
    let _served = Served::start(&t.path, &["--socket", socket.to_str().unwrap()]);

    let listed = json_out(&comments(&t.path, &["list"]));
    assert_eq!(listed["threads"], json!([]));
    assert!(listed["commentKey"].as_str().is_some_and(|k| !k.is_empty()), "{listed}");
}
