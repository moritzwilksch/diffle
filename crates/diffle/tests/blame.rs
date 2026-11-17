use crate::common;

use common::server::TestServer;
use common::{TestRepo, revspec};
use diffle::protocol::EnterRequest;
use serde_json::{Value, json};

/// `notes.txt` grows over three commits on main; feat changes its middle and renames it.
fn history() -> TestRepo {
    let t = TestRepo::new();
    t.write("notes.txt", "one\ntwo\nthree\n");
    t.commit("first draft");
    t.write("notes.txt", "one\ntwo\nthree\nfour\n");
    t.commit("add four");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("notes.txt", "one\nTWO\nthree\nfour\n");
    t.commit("shout two");
    t.git(&["mv", "notes.txt", "renamed.txt"]);
    t.commit("rename notes");
    t
}

/// Each blamed line as `<line> <summary>`, or `<line> (uncommitted)`, so a failure reads as a blame view.
fn render(body: &Value) -> Vec<String> {
    let summary = |sha: &str| {
        let commits = body["commits"].as_array().unwrap();
        commits.iter().find(|c| c["sha"] == sha).unwrap()["summary"].as_str().unwrap().to_owned()
    };
    let mut out = Vec::new();
    for hunk in body["hunks"].as_array().unwrap() {
        let start = hunk["start"].as_u64().unwrap();
        for line in start..start + hunk["lines"].as_u64().unwrap() {
            let by = hunk["commit"].as_str().map_or("(uncommitted)".to_owned(), summary);
            out.push(format!("{line} {by}"));
        }
    }
    out
}

async fn blame(s: &TestServer, req: Value) -> Vec<String> {
    let res = s.json("POST", "/api/blame", req).await;
    assert_eq!(res.status, 200, "{}", res.body);
    render(&res.json())
}

#[tokio::test]
async fn blames_each_side_at_its_own_commit_through_renames() {
    let s = TestServer::over(history(), revspec(&["main..feat"])).await;
    // The new side names the range's commit for the line it changed, and follows the rename back.
    let new = blame(&s, json!({ "path": "renamed.txt", "side": "new" })).await;
    assert_eq!(new, ["1 first draft", "2 shout two", "3 first draft", "4 add four"]);
    // The old side of a rename is read under its old path, at the range's base.
    let old = blame(&s, json!({ "path": "renamed.txt", "side": "old" })).await;
    assert_eq!(old, ["1 first draft", "2 first draft", "3 first draft", "4 add four"]);
    s.close().await;
}

#[tokio::test]
async fn blames_only_the_lines_asked_for() {
    let s = TestServer::over(history(), revspec(&["main..feat"])).await;
    let one = blame(&s, json!({ "path": "renamed.txt", "side": "new", "start": 2 })).await;
    assert_eq!(one, ["2 shout two"]);
    let range = blame(&s, json!({ "path": "renamed.txt", "side": "new", "start": 3, "end": 9 })).await;
    assert_eq!(range, ["3 first draft", "4 add four"]);
    s.close().await;
}

#[tokio::test]
async fn worktree_edits_are_uncommitted() {
    let t = history();
    t.write("renamed.txt", "one\nTWO\nthree and a half\nfour\nfive\n");
    let s = TestServer::over(t, EnterRequest::Working).await;
    let new = blame(&s, json!({ "path": "renamed.txt", "side": "new" })).await;
    assert_eq!(new, ["1 first draft", "2 shout two", "3 (uncommitted)", "4 add four", "5 (uncommitted)"]);
    s.close().await;
}

#[tokio::test]
async fn a_new_snapshot_blames_the_worktree_afresh() {
    let t = history();
    t.write("renamed.txt", "one\nTWO\nthree\nfour\nfive\n");
    let s = TestServer::over(t, EnterRequest::Working).await;
    let req = json!({ "path": "renamed.txt", "side": "new", "start": 5 });
    assert_eq!(blame(&s, req.clone()).await, ["5 (uncommitted)"]);
    // Committed, the same worktree contents name the commit once the session sees it.
    s.repo.commit("add five");
    s.session.refresh().await;
    assert_eq!(blame(&s, req).await, ["5 add five"]);
    s.close().await;
}

#[tokio::test]
async fn an_unborn_branch_is_all_uncommitted() {
    let t = TestRepo::new();
    t.write("new.txt", "a\nb");
    t.git(&["add", "new.txt"]);
    let s = TestServer::over(t, EnterRequest::Working).await;
    assert_eq!(blame(&s, json!({ "path": "new.txt", "side": "new" })).await, ["1 (uncommitted)", "2 (uncommitted)"]);
    s.close().await;
}

#[tokio::test]
async fn refuses_what_the_snapshot_does_not_show_and_bad_ranges() {
    let t = history();
    t.write(".gitignore", "secret.txt\n");
    t.write("secret.txt", "hidden\n");
    let s = TestServer::over(t, EnterRequest::Working).await;
    let status = async |req: Value| s.json("POST", "/api/blame", req).await.status;
    assert_eq!(status(json!({ "path": "secret.txt", "side": "new" })).await, 404);
    assert_eq!(status(json!({ "path": "../outside", "side": "new" })).await, 404);
    assert_eq!(status(json!({ "path": "renamed.txt", "side": "new", "start": 3, "end": 2 })).await, 400);
    assert_eq!(status(json!({ "path": "renamed.txt", "side": "new", "end": 2 })).await, 400);
    assert_eq!(status(json!({ "path": "renamed.txt", "side": "new", "start": 0 })).await, 400);
    s.close().await;
}

#[tokio::test]
async fn refuses_to_blame_a_snapshot_the_asker_does_not_show() {
    let s = TestServer::over(history(), EnterRequest::Working).await;
    let version = s.session.snapshotter().unwrap().current().await.unwrap().version;
    let status = async |version: i64| {
        s.json("POST", "/api/blame", json!({ "path": "renamed.txt", "side": "new", "version": version })).await.status
    };
    assert_eq!(status(version).await, 200);
    // An asker still showing an older snapshot gets no blame of the newer one to file under it.
    s.repo.write("renamed.txt", "changed\n");
    s.session.refresh().await;
    assert_eq!(status(version).await, 409);
    s.close().await;
}
