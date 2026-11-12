//! `diffle comments`, as an agent runs it beside a review: finding the run, then reading and answering its threads.
mod common;

use std::path::{Path, PathBuf};
use std::process::{Child, Output, Stdio};

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

/// `diffle comments <args> -C <repo>`, with `stdin` piped in.
fn comments_stdin(repo: &Path, args: &[&str], stdin: &str) -> Output {
    let config = tempfile::tempdir().unwrap();
    let mut cmd = common::cli::diffle(config.path(), &[&["comments"], args, &["-C", repo.to_str().unwrap()]].concat());
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), stdin.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

fn json_out(out: &Output) -> Value {
    assert!(out.status.success(), "{}", stderr(out));
    serde_json::from_str(&stdout(out)).unwrap()
}

fn announcement_file(repo: &Path) -> PathBuf {
    repo.join(".git").join("diffle").join("server.json")
}

/// Announces a run `instance` at `url` for `repo`, as a run that is gone now may have.
fn announce(repo: &Path, instance: &str, url: &str) -> PathBuf {
    let file = announcement_file(repo);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let announcement = json!({ "instance": instance, "pid": 1, "url": url, "version": "0.0.0" });
    std::fs::write(&file, announcement.to_string()).unwrap();
    file
}

fn assert_user_error(out: &Output, message: &str) {
    assert_eq!(out.status.code(), Some(2), "{}", stderr(out));
    assert!(stderr(out).contains(message), "{message} missing from:\n{}", stderr(out));
    assert_eq!(stdout(out), "");
}

const NOT_RUNNING: &str = "no diffle is running for this repository";

#[test]
fn deletes_an_announcement_no_connection_reaches() {
    let t = repo();
    // Where no connection completes in time: how Windows reports a closed loopback port.
    let unreachable = announce(&t.path, "7d3e2b1a-0c9f-4e8d-a7b6-5c4d3e2f1a0b", "http://10.255.255.1:9/");

    assert_user_error(&comments(&t.path, &["list"]), NOT_RUNNING);
    assert!(!unreachable.exists());
}

#[test]
fn deletes_an_announcement_whose_port_another_server_answers() {
    let t = repo();
    let other = repo();
    let foreign = Served::start(&other.path, &["--port", "0"]);
    // The port now belongs to a run for another repository, under the same instance even.
    let reused = announce(&t.path, &foreign.instance(), &foreign.url);

    assert_user_error(&comments(&t.path, &["list"]), NOT_RUNNING);
    assert!(!reused.exists());
    assert!(announcement_file(&other.path).exists());
}

#[test]
fn keeps_the_announcement_of_a_run_that_does_not_answer() {
    let t = repo();
    // Accepts connections (the kernel's backlog does) but never answers: a stalled run.
    let stalled = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", stalled.local_addr().unwrap());
    let kept = announce(&t.path, "5e0f1d2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f", &url);

    assert_user_error(&comments(&t.path, &["list"]), &format!("diffle at {url} is not answering"));
    assert!(kept.exists());
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
    let open = post(json!({ "path": "app.py", "startLine": 2, "body": "rename y" }));
    let (status, _) = http(&served.url, "POST", &format!("/api/threads/{open}/replies"), r#"{"body":"to what?"}"#);
    assert!(status.contains("201"), "{status}");
    let resolved = post(json!({ "path": "lib.py", "startLine": 1, "body": "why 2?" }));
    let (status, _) = http(&served.url, "PUT", &format!("/api/threads/{resolved}/resolved"), r#"{"resolved":true}"#);
    assert!(status.contains("200"), "{status}");
    let key = served.get("/api/snapshot")["commentKey"].clone();
    let bodies = |listed: &Value| -> Vec<String> {
        let threads = listed["threads"].as_array().unwrap();
        threads.iter().map(|t| t["messages"][0]["body"].as_str().unwrap().to_owned()).collect()
    };

    let all = json_out(&comments(&t.path, &["list"]));
    assert_eq!(all.as_object().unwrap().keys().collect::<Vec<_>>(), ["checks", "commentKey", "threads"]);
    assert_eq!(all["commentKey"], key);
    assert_eq!(bodies(&all), ["rename y", "why 2?"]);
    // What an agent reads, one line on stdout; pretty here, with ids and times masked.
    insta::assert_json_snapshot!("list", masked(all));
    assert_eq!(bodies(&json_out(&comments(&t.path, &["list", "--state", "open"]))), ["rename y"]);
    assert_eq!(bodies(&json_out(&comments(&t.path, &["list", "--state", "resolved"]))), ["why 2?"]);
    assert_eq!(bodies(&json_out(&comments(&t.path, &["list", "--path", "lib.py"]))), ["why 2?"]);
}

#[test]
fn replies_to_a_thread_as_the_agent() {
    let t = repo();
    let served = Served::start(&t.path, &["--port", "0"]);
    let (status, body) =
        http(&served.url, "POST", "/api/threads", r#"{"path":"app.py","startLine":2,"body":"why y?"}"#);
    assert!(status.contains("201"), "{status}");
    let id = serde_json::from_str::<Value>(&body).unwrap()[0]["id"].as_str().unwrap().to_owned();

    json_out(&comments(&t.path, &["reply", &id, "It counts the retries."]));
    let replied = json_out(&comments_stdin(&t.path, &["reply", &id, "-"], "Renamed it to `retries`.\n"));

    // The thread as the agent's last reply left it, as `reply` prints it.
    insta::assert_json_snapshot!("reply", masked(replied));
}

#[test]
fn refuses_a_reply_to_a_thread_the_review_lacks() {
    let t = repo();
    let _served = Served::start(&t.path, &["--port", "0"]);

    assert_user_error(&comments(&t.path, &["reply", "gone", "hello"]), "no thread gone in the review");
}

/// `value` with its ids, times and comment key masked, which change from run to run.
fn masked(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| match key.as_str() {
                    "id" | "commentKey" => (key, json!("[id]")),
                    "createdAt" | "updatedAt" | "resolvedAt" => (key, json!("[time]")),
                    _ => (key, masked(value)),
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(masked).collect()),
        value => value,
    }
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
