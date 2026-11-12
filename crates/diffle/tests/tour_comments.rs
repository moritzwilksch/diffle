//! Threads on the tour: opened on a passage or an element, moved by a revised push, made stale by a
//! clear, and read as an agent reads every thread.
mod common;

use common::TestRepo;
use common::server::TestServer;
use diffle::protocol::{EnterRequest, Tour};
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

/// A handle longer than an error's 40-character cut reaches the agent whole.
#[tokio::test]
async fn names_a_diff_on_a_long_path_in_full() {
    let repo = TestRepo::new();
    let path = "crates/diffle/src/server/routes/comments/handlers.rs";
    repo.write(path, "fn old() {}\n");
    repo.commit("base");
    repo.write(path, "fn list() {}\nfn reply() {}\n");
    let s = TestServer::over(repo, EnterRequest::Working).await;
    let html = format!(
        r#"<h2>Routes</h2><diffle-card id="routes" title="The routes"><diffle-diff path="{path}" lines="1-2"></diffle-diff></diffle-card>"#
    );
    push(&s, &html).await;
    comment(&s, json!([1, 0]), json!({ "on": "element" }), "Why both?").await;

    let prompt = s.get("/api/threads/export").await.body;

    insta::assert_snapshot!("long_path_prompt", prompt);
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

/// A push checked against one set lands there with its threads moved, whichever set is shown when it
/// writes: the tour and its threads are one write of one set.
#[tokio::test]
async fn files_a_push_and_moves_its_threads_in_the_set_it_was_checked_against() {
    let s = server().await;
    push(&s, TOUR).await;
    comment(&s, json!([2]), json!({ "on": "text", "quoted": "once per request", "occurrence": 0 }), "a").await;
    let checked = s.session.snapshotter().unwrap().current().await.unwrap();

    // Another review is shown by the time the push writes.
    let entered = s.json("POST", "/api/review", json!({ "kind": "revspec", "args": ["HEAD"] })).await;
    assert_eq!(entered.status, 200, "{}", entered.body);
    let shown = s.get("/api/snapshot").await.json()["commentKey"].as_str().unwrap().to_owned();
    assert_ne!(shown, checked.comment_key);
    let revised = TOUR.replace("<h2>The loader</h2>", "<h2>Setup</h2><p>New.</p><h2>The loader</h2>");
    let tour = Tour { html: revised.clone(), pushed_at: 0 };
    let moved = s.session.comments_for(&checked).push_tour(tour).await.unwrap();

    assert_eq!(moved.len(), 1);
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(s.repo.path.join(".git/diffle/comments.json")).unwrap()).unwrap();
    let set = &stored["sets"][&checked.comment_key];
    assert_eq!(set["tour"]["html"], revised.as_str());
    assert_eq!(places(set["threads"].as_array().unwrap()), [json!([[4], 2, false])]);
    assert!(stored["sets"][&shown].get("tour").is_none());
    assert_eq!(s.get("/api/tour").await.json()["tour"], Value::Null);
    assert_eq!(threads(&s).await, Vec::<Value>::new());
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

const CHECKLIST: &str = r#"<h2>Decide</h2>
<diffle-check>
<diffle-item context="Callers send ids they read from the store.">Should <diffle-symbol path="app.py" line="1" name="load_user"></diffle-symbol> check the id?</diffle-item>
<diffle-item>Is one request per user enough?</diffle-item>
<diffle-item>Keep the old name as an alias?</diffle-item>
<diffle-item>Ship it behind a flag?</diffle-item>
</diffle-check>"#;

#[tokio::test]
async fn hands_the_checklist_to_the_agent_and_keeps_ticks_across_a_push() {
    let s = server().await;
    push(&s, CHECKLIST).await;
    let tick = |question: &str| json!({ "question": question, "ticked": true });
    for question in ["Is one request per user enough?", "Keep the old name as an alias?"] {
        assert_eq!(s.json("PUT", "/api/tour/ticks", tick(question)).await.status, 204);
    }
    let unknown = s.json("PUT", "/api/tour/ticks", tick("Is it fast?")).await;
    assert_eq!(
        (unknown.status, unknown.json()["error"].clone()),
        (400, json!("the tour asks no question \"Is it fast?\""))
    );
    comment(&s, json!([1, 2]), json!({ "on": "element" }), "Yes, until the rename ships.").await;
    comment(&s, json!([1, 0]), json!({ "on": "element" }), "No: the store already did.").await;

    let prompt = s.get("/api/threads/export").await.body;
    let checks = s.get("/api/threads").await.json()["checks"].clone();
    // A revision that rewords one question keeps the other ticks and drops that one's.
    push(&s, &CHECKLIST.replace("Keep the old name as an alias?", "Keep old as an alias?")).await;
    let ticked: Vec<Value> = s.get("/api/tour").await.json()["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| json!([c["question"], c["ticked"]]))
        .collect();

    insta::assert_snapshot!("checklist_prompt", prompt);
    assert_eq!(
        checks.as_array().unwrap().iter().map(|c| c["thread"].is_string()).collect::<Vec<_>>(),
        [true, false, true, false]
    );
    assert_eq!(
        ticked,
        [
            json!(["Should load_user check the id?", false]),
            json!(["Is one request per user enough?", true]),
            json!(["Keep old as an alias?", false]),
            json!(["Ship it behind a flag?", false])
        ]
    );
    s.close().await;
}
