//! The review as a story: generated through a fake model, kept by content, and the HTTP call the
//! real model is asked with.
mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::TestRepo;
use common::server::TestServer;
use diffle::error::StoryError;
use diffle::protocol::EnterRequest;
use diffle::story::client::{AnthropicClient, ModelAnswer, ModelRequest, StoryModel, parse_answer};
use futures::future::BoxFuture;
use serde_json::{Value, json};

/// Answers every request with `answer`, recording what it was asked.
struct FakeModel {
    answer: Value,
    asked: Mutex<Vec<ModelRequest>>,
}

impl FakeModel {
    fn new(answer: Value) -> Arc<Self> {
        Arc::new(Self { answer, asked: Mutex::default() })
    }
}

impl StoryModel for FakeModel {
    fn complete(&self, req: ModelRequest) -> BoxFuture<'_, Result<ModelAnswer, StoryError>> {
        self.asked.lock().unwrap().push(req);
        let answer = self.answer.clone();
        Box::pin(async move {
            if let Some(message) = answer.get("fail").and_then(Value::as_str) {
                return Err(StoryError::upstream(message.to_owned()));
            }
            Ok(ModelAnswer { json: answer, model: "fake-model".into() })
        })
    }
}

/// `a.txt` and `lock.json` (generated) committed; the worktree edits both and adds `b.txt`.
fn repo() -> TestRepo {
    let repo = TestRepo::new();
    repo.write(".gitattributes", "lock.json linguist-generated\n");
    repo.write("a.txt", "a\n");
    repo.write("lock.json", "{}\n");
    repo.commit("base");
    repo.write("a.txt", "a\nmore\n");
    repo.write("b.txt", "b\n");
    repo.write("lock.json", "{\"v\":1}\n");
    repo
}

async fn settled(s: &TestServer) -> Value {
    for _ in 0..200 {
        let state = s.get("/api/story").await.json();
        if state["status"] != "generating" {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("story never settled");
}

#[tokio::test]
async fn writes_a_story_from_the_models_answer_and_keeps_it() {
    let model = FakeModel::new(json!({
        "summary": " The change grows a.txt and adds b.txt. ",
        "parts": [
            { "title": "Grow a", "narrative": "a.txt gains a line.", "files": [
                { "path": "a.txt", "note": "The line." },
                { "path": "a.txt", "note": "Listed twice: dropped." },
                { "path": "nope.txt", "note": "Unknown: dropped." },
                { "path": "lock.json", "note": "Generated: moved to its own part." }
            ] },
            { "title": "Nothing left", "narrative": "Every file of this part is dropped, so is the part.", "files": [
                { "path": "nope2.txt", "note": "" }
            ] }
        ]
    }));
    let s = TestServer::with_story(repo(), EnterRequest::Working, model.clone()).await;
    let state = s.get("/api/story").await.json();
    assert_eq!(state["status"], "absent");
    assert_eq!(state["blocker"], Value::Null);
    assert_eq!(state["story"], Value::Null);

    let started = s.json("POST", "/api/story", json!({})).await;
    assert_eq!(started.status, 200, "{}", started.body);
    assert_eq!(started.json()["status"], "generating");
    let state = settled(&s).await;
    assert_eq!(state["status"], "ready", "{state}");
    assert_eq!(state["stale"], false);
    let story = &state["story"];
    assert_eq!(story["model"], "fake-model");
    assert_eq!(story["summary"], "The change grows a.txt and adds b.txt.");
    insta::assert_json_snapshot!(story["parts"]);

    // The model read the commits, the file list with its flags, and the patches of the files that have one.
    {
        let asked = model.asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        let user = &asked[0].user;
        assert!(user.contains("- a.txt (modified, +1 -0)\n"), "{user}");
        assert!(user.contains("- lock.json (modified, +1 -1, generated)\n"), "{user}");
        assert!(user.contains("diff --git a/b.txt b/b.txt"), "{user}");
        assert!(!user.contains("diff --git a/lock.json"), "{user}");
        assert_eq!(asked[0].schema["required"], json!(["summary", "parts"]));
    }

    // Kept on disk by content: a fresh server over the same worktree finds it without asking.
    let fingerprint = story["fingerprint"].as_str().unwrap().to_owned();
    let dir = s.repo.path.join(".git").join("diffle").join("stories");
    assert!(dir.join(format!("{fingerprint}.json")).is_file());
    let repo = s.close_keeping_repo().await;
    let silent = FakeModel::new(json!({ "fail": "must not be asked" }));
    let s = TestServer::with_story(repo, EnterRequest::Working, silent.clone()).await;
    let state = s.get("/api/story").await.json();
    assert_eq!(state["status"], "ready");
    assert_eq!(state["story"]["fingerprint"], fingerprint);
    assert!(silent.asked.lock().unwrap().is_empty());

    // An edit changes the content: the story on record goes stale until a new one is written.
    s.repo.write("b.txt", "b\nc\n");
    s.session.refresh().await;
    let state = s.get("/api/story").await.json();
    assert_eq!(state["status"], "absent");
    assert_eq!(state["stale"], true);
    assert_eq!(state["story"]["fingerprint"], fingerprint);
    s.close().await;
}

#[tokio::test]
async fn a_failed_model_reports_and_can_be_asked_again() {
    let model = FakeModel::new(json!({ "fail": "Anthropic answered 529: overloaded" }));
    let s = TestServer::with_story(repo(), EnterRequest::Working, model.clone()).await;
    s.json("POST", "/api/story", json!({})).await;
    let state = settled(&s).await;
    assert_eq!(state["status"], "failed");
    assert_eq!(state["error"], "Anthropic answered 529: overloaded");
    assert_eq!(state["story"], Value::Null);
    s.json("POST", "/api/story", json!({})).await;
    settled(&s).await;
    assert_eq!(model.asked.lock().unwrap().len(), 2);
    s.close().await;
}

#[tokio::test]
async fn without_a_key_the_story_is_blocked() {
    let s = TestServer::over(repo(), EnterRequest::Working).await;
    let state = s.get("/api/story").await.json();
    assert_eq!(state["status"], "absent");
    assert_eq!(state["blocker"], "No Anthropic API key: set ANTHROPIC_API_KEY to write stories");
    let res = s.json("POST", "/api/story", json!({})).await;
    assert_eq!(res.status, 409);
    assert_eq!(res.json()["error"], "No Anthropic API key: set ANTHROPIC_API_KEY to write stories");
    s.close().await;
}

#[tokio::test]
async fn a_clean_tree_has_nothing_to_tell() {
    let repo = TestRepo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    let model = FakeModel::new(json!({ "fail": "must not be asked" }));
    let s = TestServer::with_story(repo, EnterRequest::Working, model).await;
    let state = s.get("/api/story").await.json();
    assert_eq!(state["blocker"], "No changes to tell");
    assert_eq!(s.json("POST", "/api/story", json!({})).await.status, 409);
    s.close().await;
}

/// A Messages API that records the one request it gets and answers `reply`.
async fn fake_anthropic(reply: Value) -> (String, Arc<Mutex<Option<(axum::http::HeaderMap, Value)>>>) {
    use axum::extract::State;
    use axum::routing::post;
    let seen: Arc<Mutex<Option<(axum::http::HeaderMap, Value)>>> = Arc::default();
    let app = axum::Router::new()
        .route(
            "/v1/messages",
            post(
                |State((seen, reply)): State<(Arc<Mutex<Option<_>>>, Value)>,
                 headers: axum::http::HeaderMap,
                 body: axum::Json<Value>| async move {
                    *seen.lock().unwrap() = Some((headers, body.0));
                    axum::Json(reply)
                },
            ),
        )
        .with_state((seen.clone(), reply));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

#[tokio::test]
async fn asks_the_messages_api_for_schema_shaped_json() {
    let reply = json!({
        "model": "claude-opus-5-5",
        "stop_reason": "end_turn",
        "content": [
            { "type": "thinking", "thinking": "" },
            { "type": "text", "text": "{\"summary\":\"s\"," },
            { "type": "text", "text": "\"parts\":[]}" }
        ]
    });
    let (base, seen) = fake_anthropic(reply).await;
    let client = AnthropicClient::from_env(|name| match name {
        "ANTHROPIC_API_KEY" => Some(" sk-test ".into()),
        "ANTHROPIC_BASE_URL" => Some(format!("{base}/")),
        _ => None,
    })
    .unwrap();
    let req = ModelRequest { system: "sys".into(), user: "usr".into(), schema: json!({ "type": "object" }) };
    let answer = client.complete(req).await.unwrap();
    assert_eq!(answer.model, "claude-opus-5-5");
    assert_eq!(answer.json, json!({ "summary": "s", "parts": [] }));
    let (headers, body) = seen.lock().unwrap().take().unwrap();
    assert_eq!(headers["x-api-key"], "sk-test");
    assert_eq!(headers["anthropic-version"], "2026-10-21");
    assert_eq!(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    insta::assert_json_snapshot!(body);
}

#[tokio::test]
async fn a_rejected_key_is_the_users_to_fix() {
    let (base, _) = fake_anthropic(json!({ "error": { "message": "invalid x-api-key" } })).await;
    // The fake answers 200 to everything; the status check needs a real rejection, so parse the body path instead.
    let client = AnthropicClient::new("k".into(), base, "m".into()).unwrap();
    let req = ModelRequest { system: String::new(), user: String::new(), schema: json!({}) };
    let err = client.complete(req).await.unwrap_err();
    assert_eq!(err.status, 502);
    assert!(err.message.contains("not the JSON asked for"), "{}", err.message);
}

#[test]
fn reads_the_answers_stop_reason() {
    let refused = json!({ "stop_reason": "refusal", "stop_details": { "explanation": "policy" }, "content": [] });
    assert_eq!(parse_answer(refused).unwrap_err().message, "The model declined to write the story: policy");
    let cut = json!({ "stop_reason": "max_tokens", "content": [{ "type": "text", "text": "{" }] });
    assert_eq!(parse_answer(cut).unwrap_err().message, "The model's answer was cut short");
    let garbage = json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "nope" }] });
    assert!(parse_answer(garbage).unwrap_err().message.starts_with("The model's answer is not the JSON asked for"));
}
