//! `GET /api/threads/activity`: a long poll on the comment activity log, which also drives `/ws`.
use crate::common;

use std::time::{Duration, Instant};

use common::TestRepo;
use common::server::TestServer;
use diffle::protocol::EnterRequest;
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

/// Long enough for a wait that should not end to have ended if it were going to.
const QUIET: Duration = Duration::from_millis(300);

/// Waits on the server from its own task, as a backgrounded `diffle comments wait` does.
fn wait(s: &TestServer, query: &str) -> JoinHandle<Value> {
    let url = format!("{}api/threads/activity?{query}", s.base);
    tokio::spawn(async move { reqwest::get(url).await.unwrap().json().await.unwrap() })
}

async fn cursor(s: &TestServer) -> String {
    s.get("/api/threads/activity").await.json()["cursor"].as_str().unwrap().to_owned()
}

async fn open(s: &TestServer, body: Value) -> String {
    s.json("POST", "/api/threads", body).await.json()[0]["id"].as_str().unwrap().to_owned()
}

async fn still_waiting(waiting: &JoinHandle<Value>) -> bool {
    tokio::time::sleep(QUIET).await;
    !waiting.is_finished()
}

fn ids(threads: &Value) -> Vec<&str> {
    threads.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn answers_the_shown_set_and_a_fresh_cursor_without_since() {
    let s = TestServer::start().await;
    let id = open(&s, json!({ "path": "a.txt", "body": "Rename it." })).await;
    let r = s.get("/api/threads/activity").await.json();
    assert_eq!((&r["cursor"], &r["commentKey"]), (&json!("test:1"), &json!("working")));
    assert_eq!(ids(&r["threads"]), [id.as_str()]);
    assert_eq!((&r["removed"], &r["resync"], &r["closed"]), (&json!([]), &json!(false), &json!(false)));
    s.close().await;
}

#[tokio::test]
async fn wakes_on_a_reviewer_reply_and_not_on_any_write_by_the_ignored_author() {
    let s = TestServer::start().await;
    let since = cursor(&s).await;
    let waiting = wait(&s, &format!("since={since}&ignore=agent"));
    let id = open(&s, json!({ "path": "a.txt", "body": "Split it.", "author": "agent" })).await;
    let other = open(&s, json!({ "path": "a.txt", "body": "Drop it.", "author": "agent" })).await;
    let replied =
        s.json("POST", &format!("/api/threads/{id}/replies"), json!({ "body": "Why?", "author": "agent" })).await;
    let mid = replied.json()["messages"][1]["id"].as_str().unwrap().to_owned();
    let message = format!("/api/threads/{id}/messages/{mid}");
    s.json("PATCH", &message, json!({ "body": "Why not?", "author": "agent" })).await;
    s.send("DELETE", &format!("{message}?author=agent"), &[], None).await;
    s.json("PUT", &format!("/api/threads/{id}/resolved"), json!({ "resolved": true, "author": "agent" })).await;
    s.send("DELETE", &format!("/api/threads/{other}?author=agent"), &[], None).await;
    assert!(still_waiting(&waiting).await, "the ignored author's writes woke it");
    s.json("POST", &format!("/api/threads/{id}/replies"), json!({ "body": "Because." })).await;
    let r = waiting.await.unwrap();
    // The ignored writes ride along once something else woke the wait.
    assert_eq!(r["cursor"], "test:8");
    assert_eq!(ids(&r["threads"]), [id.as_str()]);
    assert_eq!(r["removed"], json!([other]));
    assert_eq!(r["threads"][0]["messages"].as_array().unwrap().len(), 2);
    s.close().await;
}

#[tokio::test]
async fn wakes_on_every_author_without_ignore() {
    let s = TestServer::start().await;
    let since = cursor(&s).await;
    let waiting = wait(&s, &format!("since={since}"));
    let id = open(&s, json!({ "path": "a.txt", "body": "Split it.", "author": "agent" })).await;
    let r = waiting.await.unwrap();
    assert_eq!((&r["cursor"], ids(&r["threads"])), (&json!("test:1"), vec![id.as_str()]));
    let cleared = s.send("DELETE", "/api/threads?author=agent", &[], None).await;
    assert_eq!(cleared.status, 204);
    let quiet = wait(&s, "since=test:1&ignore=agent&timeout=0").await.unwrap();
    assert_eq!((&quiet["cursor"], &quiet["removed"]), (&json!("test:1"), &json!([])));
    let r = wait(&s, "since=test:1").await.unwrap();
    assert_eq!((&r["cursor"], &r["removed"]), (&json!("test:2"), &json!([id])));
    s.close().await;
}

#[tokio::test]
async fn announces_each_change_on_the_socket_with_its_cursor() {
    let s = TestServer::start().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(s.ws_url()).await.unwrap();
    let id = open(&s, json!({ "path": "a.txt", "body": "Split it.", "author": "agent" })).await;
    s.json("PUT", &format!("/api/threads/{id}/resolved"), json!({ "resolved": true })).await;
    for cursor in ["test:1", "test:2"] {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();
        let message: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(message, json!({ "type": "threads", "cursor": cursor }));
    }
    // A write that changed nothing announces nothing.
    s.send("DELETE", "/api/threads?stale=1", &[], None).await;
    assert!(tokio::time::timeout(QUIET, ws.next()).await.is_err());
    s.close().await;
}

#[tokio::test]
async fn wakes_on_a_deletion_and_names_the_thread_removed() {
    let s = TestServer::start().await;
    let id = open(&s, json!({ "path": "a.txt", "body": "Split it.", "author": "agent" })).await;
    let since = cursor(&s).await;
    let waiting = wait(&s, &format!("since={since}&ignore=agent"));
    assert!(still_waiting(&waiting).await);
    s.send("DELETE", &format!("/api/threads/{id}"), &[], None).await;
    let r = waiting.await.unwrap();
    assert_eq!((&r["threads"], &r["removed"]), (&json!([]), &json!([id])));
    s.close().await;
}

#[tokio::test]
async fn reports_nothing_already_seen_and_keeps_the_cursor_on_timeout() {
    let s = TestServer::start().await;
    open(&s, json!({ "path": "a.txt", "body": "Rename it." })).await;
    let woke = wait(&s, "since=test:0").await.unwrap();
    assert_eq!(woke["threads"].as_array().unwrap().len(), 1);
    let since = woke["cursor"].as_str().unwrap();
    let started = Instant::now();
    let r = wait(&s, &format!("since={since}&timeout=1")).await.unwrap();
    assert!(started.elapsed() >= Duration::from_secs(1));
    assert_eq!(
        (&r["cursor"], &r["threads"], &r["resync"], &r["closed"]),
        (&json!(since), &json!([]), &json!(false), &json!(false))
    );
    s.close().await;
}

#[tokio::test]
async fn resyncs_a_cursor_of_another_run_or_out_of_the_window() {
    let s = TestServer::start().await;
    let id = open(&s, json!({ "path": "a.txt", "body": "Rename it." })).await;
    for since in ["other:1", "test:2"] {
        let r = s.get(&format!("/api/threads/activity?since={since}")).await.json();
        assert_eq!((&r["cursor"], &r["resync"]), (&json!("test:1"), &json!(true)), "{since}");
        assert_eq!(ids(&r["threads"]), [id.as_str()]);
    }
    // More changes than the log keeps push the oldest cursors out of it.
    let many: Vec<Value> = (0..1024).map(|n| json!({ "path": "a.txt", "body": format!("#{n}") })).collect();
    assert_eq!(s.json("POST", "/api/threads", json!(many)).await.status, 201);
    let r = s.get("/api/threads/activity?since=test:0").await.json();
    assert_eq!((&r["cursor"], &r["resync"]), (&json!("test:1025"), &json!(true)));
    assert_eq!(r["threads"].as_array().unwrap().len(), 1025);
    let r = s.get("/api/threads/activity?since=test:1").await.json();
    assert_eq!((r["resync"].clone(), r["threads"].as_array().unwrap().len()), (json!(false), 1024));
    s.close().await;
}

#[tokio::test]
async fn refuses_a_malformed_cursor_or_timeout() {
    let s = TestServer::start().await;
    for query in ["since=7", "since=test:x", "since=test:0&timeout=-1", "since=test:0&ignore=bot"] {
        assert_eq!(s.get(&format!("/api/threads/activity?{query}")).await.status, 400, "{query}");
    }
    s.close().await;
}

#[tokio::test]
async fn wakes_when_the_reviewer_switches_the_comment_key() {
    let repo = TestRepo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    repo.write("a.txt", "b\n");
    repo.commit("change");
    let s = TestServer::over(repo, EnterRequest::Working).await;
    open(&s, json!({ "path": "a.txt", "body": "Rename it." })).await;
    let since = cursor(&s).await;
    let waiting = wait(&s, &format!("since={since}"));
    assert!(still_waiting(&waiting).await);
    let entered = s.json("POST", "/api/review", json!({ "kind": "revspec", "args": ["HEAD"] })).await;
    assert_eq!(entered.status, 200, "{}", entered.body);
    let r = waiting.await.unwrap();
    assert_ne!(r["commentKey"], "working");
    assert_eq!((&r["cursor"], &r["threads"], &r["removed"]), (&json!("test:2"), &json!([]), &json!([])));
    s.close().await;
}

#[tokio::test]
async fn answers_closed_when_the_server_closes() {
    let s = TestServer::start().await;
    let since = cursor(&s).await;
    let waiting = wait(&s, &format!("since={since}"));
    assert!(still_waiting(&waiting).await);
    s.close().await;
    let r = waiting.await.unwrap();
    assert_eq!((&r["cursor"], &r["closed"], &r["threads"]), (&json!(since), &json!(true), &json!([])));
}
