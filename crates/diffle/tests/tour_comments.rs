//! Threads on the tour: opened on a passage or an element, moved by a revised push, made stale by a
//! clear, and read as an agent reads every thread.
mod common;

use common::TestRepo;
use common::server::TestServer;
use diffle::protocol::EnterRequest;
use serde_json::{Value, json};

async fn server() -> TestServer {
    let repo = TestRepo::new();
    repo.write("app.py", "def old(): pass\n");
    repo.commit("base");
    repo.write("app.py", "def load_user(id):\n    return id\n");
    TestServer::over(repo, EnterRequest::Working).await
}

const TOUR: &str = r#"<h1>Loading users</h1>
<h2>The loader</h2>
<p>It calls <diffle-symbol path="app.py" line="1" name="load_user"></diffle-symbol> once per request.</p>
<diffle-card id="entry" title="The loader returns the id"><p>It replaces old.</p><diffle-diff path="app.py" lines="1-2"></diffle-diff></diffle-card>
<h2>Wiring</h2>
<diffle-diagram><svg viewBox="0 0 200 60"><rect x="8" y="8" width="96" height="40"></rect><text x="56" y="28">Session</text></svg></diffle-diagram>"#;

async fn push(s: &TestServer, html: &str) {
    let res = s.json("PUT", "/api/tour", json!({ "html": html })).await;
    assert_eq!(res.status, 200, "{}", res.body);
}

async fn comment(s: &TestServer, node: Value, target: Value, body: &str) -> Value {
    let res = s.json("POST", "/api/tour/threads", json!({ "node": node, "target": target, "body": body })).await;
    assert_eq!(res.status, 201, "{}", res.body);
    res.json()
}

async fn threads(s: &TestServer) -> Vec<Value> {
    s.get("/api/threads").await.json()["threads"].as_array().unwrap().clone()
}

/// What stays put across runs of each thread: where it is, and whether it is stale.
fn places(threads: &[Value]) -> Vec<Value> {
    threads.iter().map(|t| json!([t["anchor"]["node"], t["anchor"]["step"], t["stale"]])).collect()
}

#[tokio::test]
async fn hands_tour_threads_to_the_agent_after_the_code_threads() {
    let s = server().await;
    push(&s, TOUR).await;
    let code = s.json("POST", "/api/threads", json!({ "path": "app.py", "startLine": 2, "body": "Why the id?" })).await;
    assert_eq!(code.status, 201, "{}", code.body);
    comment(&s, json!([2]), json!({ "on": "text", "quoted": "once per\n request", "occurrence": 0 }), "Per request?")
        .await;
    let card = comment(&s, json!([3]), json!({ "on": "element" }), "Name the caller.").await;
    comment(&s, json!([5, 0, 0]), json!({ "on": "element" }), "Is this the store?").await;
    let res = s
        .json(
            "POST",
            &format!("/api/threads/{}/replies", card["id"].as_str().unwrap()),
            json!({ "body": "The handler.", "author": "agent" }),
        )
        .await;
    assert_eq!(res.status, 201, "{}", res.body);

    let prompt = s.get("/api/threads/export").await.body;

    insta::assert_snapshot!("prompt", prompt);
}

#[tokio::test]
async fn follows_threads_into_a_revised_tour_and_marks_the_lost_ones_stale() {
    let s = server().await;
    push(&s, TOUR).await;
    comment(&s, json!([2]), json!({ "on": "text", "quoted": "once per request", "occurrence": 0 }), "a").await;
    comment(&s, json!([5, 0, 0]), json!({ "on": "element" }), "b").await;

    // A section before both; the phrase rewritten, the box kept.
    let revised = TOUR
        .replace("<h2>The loader</h2>", "<h2>Setup</h2><p>New.</p><h2>The loader</h2>")
        .replace("once per request", "per call");
    push(&s, &revised).await;
    assert_eq!(places(&threads(&s).await), [json!([[2], 1, true]), json!([[7, 0, 0], 3, false])]);

    // The phrase back: the stale thread follows it again.
    push(&s, &revised.replace("per call", "once per request")).await;
    assert_eq!(places(&threads(&s).await), [json!([[4], 2, false]), json!([[7, 0, 0], 3, false])]);

    let res = s.send("DELETE", "/api/tour", &[], None).await;
    assert_eq!(res.status, 204);
    assert_eq!(places(&threads(&s).await), [json!([[4], 2, true]), json!([[7, 0, 0], 3, true])]);
}

#[tokio::test]
async fn refuses_a_thread_the_tour_cannot_hold() {
    let s = server().await;
    let target = json!({ "on": "element" });
    let refused = |res: common::server::Res| (res.status, res.json()["error"].clone());

    let none = s.json("POST", "/api/tour/threads", json!({ "node": [3], "target": target, "body": "x" })).await;
    assert_eq!(refused(none), (400, json!("the review has no tour")));
    push(&s, TOUR).await;
    let missing = s
        .json(
            "POST",
            "/api/tour/threads",
            json!({ "node": [2], "target": { "on": "text", "quoted": "twice", "occurrence": 0 }, "body": "x" }),
        )
        .await;
    assert_eq!(refused(missing), (400, json!("\"twice\" is not in <p>")));
    let prose = s.json("POST", "/api/tour/threads", json!({ "node": [2], "target": target, "body": "x" })).await;
    assert_eq!(refused(prose), (400, json!("<p> takes no comment as a whole")));
}
