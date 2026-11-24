use serde_json::{Value, json};

use crate::common::{TestRepo, server::TestServer};
use diffle::protocol::EnterRequest;

#[tokio::test]
async fn refreshes_feedback_locations_and_records_one_reply_to_each_revision() {
    let repo = TestRepo::new();
    repo.write("a.txt", "header\nold\nanchor\nrest\n");
    repo.commit("base");
    repo.write("a.txt", "header\nreview me\nanchor\nrest\n");
    let s = TestServer::over(repo, EnterRequest::Working).await;
    let created =
        s.json("POST", "/api/threads", json!({"path":"a.txt", "startLine":2, "body":"Revise that line."})).await;
    assert_eq!(created.status, 201);
    let thread = created.json()[0]["id"].as_str().unwrap().to_owned();
    let pending = s.get("/api/feedback").await.json();
    let target = pending[0]["target"].as_str().unwrap();
    let path = format!("/api/feedback/{target}");
    assert_eq!(pending[0]["original"]["before"], json!([{"line":1,"text":"header","truncated":false}]));

    s.repo.write("a.txt", "inserted\nheader\nreview me\nanchor\nrest\n");
    let context = s.get(&path).await.json();
    assert_eq!(context["location"], "moved");
    assert_eq!(context["item"]["original"]["startLine"], 2);
    assert_eq!(context["current"]["startLine"], 3);

    let answer = s.json("POST", &path, json!({"summary":"Revised the line."})).await;
    assert_eq!(answer.status, 200);
    let repeat = s.json("POST", &path, json!({"summary":"This retry adds no reply."})).await;
    assert_eq!(repeat.json(), answer.json());
    assert_eq!(s.get("/api/feedback").await.json(), json!([]));
    let resolve_path = format!("/api/threads/{thread}/resolved");
    assert_eq!(s.json("PUT", &resolve_path, json!({"resolved":true})).await.json()["resolved"], true);
    let stored = s.get("/api/threads?state=resolved").await.json();
    assert_eq!(stored["threads"][0]["messages"][1]["author"], "agent");
    let follow_up = s.json("POST", &format!("/api/threads/{thread}/replies"), json!({"body":"One more change."})).await;
    assert_eq!(follow_up.json()["resolved"], false);
    assert_eq!(s.get("/api/feedback").await.json()[0]["feedback"], "One more change.");
    s.close().await;
}

#[tokio::test]
async fn working_reviews_remember_threads_and_resolution_by_checkout_branch() {
    let repo = TestRepo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    repo.git(&["branch", "other"]);
    let s = TestServer::over(repo, EnterRequest::Working).await;
    let post = |body: &'static str| s.json("POST", "/api/threads", json!({"path":"a.txt", "body":body}));
    let created = post("Main feedback.").await.json();
    let id = created[0]["id"].as_str().unwrap();
    let main: Value = s.get("/api/feedback").await.json();
    let stale_target = format!("/api/feedback/{}", main[0]["target"].as_str().unwrap());
    s.json("PUT", &format!("/api/threads/{id}/resolved"), json!({"resolved":true})).await;

    s.repo.git(&["switch", "other"]);
    assert_eq!(s.get(&stale_target).await.status, 400);
    let other = s.json("POST", "/api/reload", json!({})).await.json();
    assert_eq!(other["commentKey"], "working:branch:other");
    assert_eq!(s.get("/api/threads").await.json()["threads"], json!([]));
    post("Other feedback.").await;

    s.repo.git(&["switch", "main"]);
    let main = s.json("POST", "/api/reload", json!({})).await.json();
    assert_eq!(main["commentKey"], "working:branch:main");
    let restored = s.get("/api/threads").await.json();
    assert_eq!(
        restored["threads"],
        json!([{
            "id": id,
            "anchor": {"kind":"file","path":"a.txt"},
            "messages": created[0]["messages"],
            "resolved": true,
            "resolvedAt": restored["threads"][0]["resolvedAt"],
            "stale": false,
        }])
    );
    assert_eq!(s.json("POST", &stale_target, json!({"summary":"Wrong review visit."})).await.status, 400);
    s.close().await;
}
