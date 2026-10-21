//! Threads as a pending GitHub review: building it, and creating or merging into the viewer's draft.
mod common;

use std::sync::{Arc, Mutex};

use common::github::{Call, FakeGithub};
use diffle::error::{Error, GithubError};
use diffle::github::client::GithubClient;
use diffle::github::pulls::repo_of_pr_url;
use diffle::github::review::{ExportInput, GithubExporter, build_review, format_body};
use diffle::protocol::{
    CommentAnchor, CommentMessage, CommentThread, GithubExportResponse, GithubPullRequest, GithubPullRequestState, Side,
};
use serde_json::{Value, json};

const PR_URL: &str = "https://github.com/o/r/pull/7";

fn head() -> String {
    "a".repeat(40)
}

/// A line thread on `a.txt`, line 3 of the new side, saying "hi", unless told otherwise.
#[derive(Clone)]
struct T {
    id: &'static str,
    path: &'static str,
    line: i64,
    end_line: Option<i64>,
    side: Side,
    body: &'static str,
    resolved: bool,
    stale: bool,
}

fn t(id: &'static str) -> T {
    T { id, path: "a.txt", line: 3, end_line: None, side: Side::New, body: "hi", resolved: false, stale: false }
}

impl T {
    fn path(mut self, path: &'static str) -> Self {
        self.path = path;
        self
    }
    fn line(mut self, line: i64) -> Self {
        self.line = line;
        self
    }
    fn lines(mut self, line: i64, end: i64) -> Self {
        self.line = line;
        self.end_line = Some(end);
        self
    }
    fn old(mut self) -> Self {
        self.side = Side::Old;
        self
    }
    fn body(mut self, body: &'static str) -> Self {
        self.body = body;
        self
    }
    fn resolved(mut self) -> Self {
        self.resolved = true;
        self
    }
    fn stale(mut self) -> Self {
        self.stale = true;
        self
    }
    fn build(self) -> CommentThread {
        let anchor = CommentAnchor::Line {
            path: self.path.into(),
            side: self.side,
            start_line: self.line,
            end_line: self.end_line.unwrap_or(self.line),
            quoted: "x".into(),
        };
        thread_with(self.id, anchor, self.body, self.resolved, self.stale)
    }
}

fn thread_with(id: &str, anchor: CommentAnchor, body: &str, resolved: bool, stale: bool) -> CommentThread {
    CommentThread {
        anchor,
        id: id.into(),
        messages: vec![CommentMessage { id: format!("{id}-m"), body: body.into(), created_at: 1, updated_at: 1 }],
        resolved,
        resolved_at: None,
        stale,
        stale_from_line: None,
    }
}

/// A thread on the file as a whole.
fn file_thread(id: &str, body: &str, path: &str) -> CommentThread {
    thread_with(id, CommentAnchor::File { path: path.into() }, body, false, false)
}

fn json_of<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

#[test]
fn build_review_maps_sides_and_multi_line_ranges_to_the_review_thread_shape() {
    let built = build_review(&[t("n").build(), t("o").old().lines(5, 8).body("gone").build()], None);
    assert!(built.skipped.is_empty());
    assert_eq!(
        json_of(&built.comments),
        json!([
            { "path": "a.txt", "line": 3, "side": "RIGHT", "body": "hi" },
            { "path": "a.txt", "line": 8, "side": "LEFT", "startLine": 5, "startSide": "LEFT", "body": "gone" },
        ])
    );
}

#[test]
fn build_review_keeps_file_threads_in_the_comment_list_in_review_order() {
    let built = build_review(&[t("n").build(), file_thread("f", "whole file", "a.txt")], None);
    assert_eq!(
        json_of(&built.comments),
        json!([
            { "path": "a.txt", "subjectType": "FILE", "body": "whole file" },
            { "path": "a.txt", "line": 3, "side": "RIGHT", "body": "hi" },
        ])
    );
    assert_eq!(built.ids, ["f", "n"]);
}

#[test]
fn build_review_skips_stale_threads_and_without_ids_resolved_ones() {
    let built = build_review(&[t("s").stale().build(), t("r").resolved().build(), t("k").build()], None);
    assert_eq!(built.comments.iter().map(|c| c.body.as_str()).collect::<Vec<_>>(), ["hi"]);
    assert_eq!(json_of(&built.skipped), json!([{ "id": "s", "reason": "stale" }]));
}

#[test]
fn build_review_with_ids_posts_the_named_threads_resolved_included_and_reports_unknown_ids() {
    let ids = ["r".to_owned(), "nope".to_owned()];
    let built = build_review(&[t("r").resolved().body("done").build(), t("k").build()], Some(&ids));
    assert_eq!(built.comments.iter().map(|c| c.body.as_str()).collect::<Vec<_>>(), ["done"]);
    assert_eq!(json_of(&built.skipped), json!([{ "id": "nope", "reason": "unknown thread" }]));
}

#[test]
fn format_body_joins_messages_and_keeps_suggestion_fences_verbatim() {
    let body = format_body(&[
        CommentMessage { id: "1".into(), body: "Batch this.".into(), created_at: 1, updated_at: 1 },
        CommentMessage { id: "2".into(), body: "```suggestion\nfoo()\n```".into(), created_at: 2, updated_at: 2 },
    ]);
    assert_eq!(body, "Batch this.\n\n---\n\n```suggestion\nfoo()\n```");
}

#[test]
fn repo_of_pr_url_takes_the_base_repo_from_the_pull_request_url_on_github_com_and_elsewhere() {
    assert_eq!(repo_of_pr_url(PR_URL).unwrap(), ("o".into(), "r".into()));
    assert_eq!(repo_of_pr_url("https://ghe.example.com/acme/app/pull/12").unwrap(), ("acme".into(), "app".into()));
    assert!(repo_of_pr_url("https://github.com/o/r/issues/7").is_err());
}

/// One comment already in the pending review, as a review thread reports it. A file comment has no line.
#[derive(Clone)]
struct Existing {
    node_id: &'static str,
    path: &'static str,
    side: &'static str,
    line: Option<i64>,
    start_line: Option<i64>,
    body: String,
}

fn existing(node_id: &'static str, path: &'static str, side: &'static str, line: i64, body: &str) -> Existing {
    Existing { node_id, path, side, line: Some(line), start_line: None, body: body.into() }
}

fn existing_file(node_id: &'static str, path: &'static str, body: &str) -> Existing {
    Existing { node_id, path, side: "RIGHT", line: None, start_line: None, body: body.into() }
}

/// Which GitHub operation a recorded call was.
fn op(query: &str) -> &'static str {
    if query.contains("reviewThreads") {
        "threads"
    } else if query.starts_with("query") {
        "pending"
    } else if query.contains("addPullRequestReviewThread") {
        "addThread"
    } else if query.contains("updatePullRequestReviewComment") {
        "updateComment"
    } else {
        "createReview"
    }
}

/// `reviewThreads` shape: one thread per comment, all of them on `review_id`.
fn thread_nodes(existing: &[Existing], review_id: &str) -> Value {
    Value::Array(
        existing
            .iter()
            .map(|c| {
                json!({
                    "path": c.path,
                    "line": c.line,
                    "startLine": c.start_line.or(c.line),
                    "diffSide": c.side,
                    "subjectType": if c.line.is_none() { "FILE" } else { "LINE" },
                    "comments": { "nodes": [{ "id": c.node_id, "body": c.body, "pullRequestReview": { "id": review_id } }] },
                })
            })
            .collect(),
    )
}

/// The base answer for `op`: `pending` names the viewer's pending review, `existing` what it holds.
fn answer(op: &str, pending: Option<&str>, existing: &[Existing]) -> Value {
    match op {
        "threads" => {
            let review_threads = json!({ "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": thread_nodes(existing, pending.unwrap_or("")) });
            json!({ "repository": { "pullRequest": { "reviewThreads": review_threads } } })
        }
        "pending" => {
            let nodes: Vec<Value> =
                pending.map(|id| json!({ "id": id, "author": { "login": "me" } })).into_iter().collect();
            json!({ "viewer": { "login": "me" }, "repository": { "pullRequest": { "id": "PR_7", "reviews": { "nodes": nodes } } } })
        }
        "updateComment" => json!({ "updatePullRequestReviewComment": { "pullRequestReviewComment": { "id": "c" } } }),
        "createReview" => json!({ "addPullRequestReview": { "pullRequestReview": { "id": "PRR_NEW" } } }),
        _ => json!({ "addPullRequestReviewThread": { "thread": { "id": "t" } } }),
    }
}

type Shared = Arc<Mutex<Vec<Existing>>>;

/// A GitHub with `pending` as the viewer's pending review holding `existing`.
fn client(pending: Option<&'static str>, existing: Vec<Existing>) -> FakeGithub {
    client_shared(pending, Arc::new(Mutex::new(existing)))
}

fn client_shared(pending: Option<&'static str>, existing: Shared) -> FakeGithub {
    FakeGithub::new(move |query: String, _| {
        let value = answer(op(&query), pending, &existing.lock().unwrap());
        async move { Ok(value) }
    })
}

/// `fn` answers (or fails) the calls it wants; `None` hands the call to the base answer.
fn intercept<F>(pending: Option<&'static str>, existing: Vec<Existing>, f: F) -> FakeGithub
where
    F: Fn(&str, &Value) -> Option<Result<Value, GithubError>> + Send + Sync + 'static,
{
    let existing: Shared = Arc::new(Mutex::new(existing));
    FakeGithub::new(move |query: String, vars: Value| {
        let out = f(op(&query), &vars).unwrap_or_else(|| Ok(answer(op(&query), pending, &existing.lock().unwrap())));
        async move { out }
    })
}

fn pull_request() -> GithubPullRequest {
    GithubPullRequest {
        repository: "o/r".into(),
        number: 7,
        url: PR_URL.into(),
        title: "Review".into(),
        state: GithubPullRequestState::Open,
        is_draft: false,
    }
}

async fn export_on(
    exporter: &GithubExporter,
    github: &FakeGithub,
    threads: Vec<CommentThread>,
    thread_ids: Option<Vec<String>>,
    new_sha: &str,
) -> Result<GithubExportResponse, GithubError> {
    let input = ExportInput {
        new_sha: new_sha.into(),
        pull_request: pull_request(),
        threads,
        thread_ids,
        github: Arc::new(github.clone()) as Arc<dyn GithubClient>,
    };
    exporter.export(|| async { Ok(input) }).await.map_err(|e| match e {
        Error::Github(e) => e,
        other => panic!("not a GitHub error: {other}"),
    })
}

async fn export(github: &FakeGithub, threads: Vec<CommentThread>) -> Result<GithubExportResponse, GithubError> {
    export_on(&GithubExporter::default(), github, threads, None, &head()).await
}

fn ops(calls: &[Call]) -> Vec<&'static str> {
    calls.iter().map(|c| op(&c.query)).collect()
}

fn inputs(calls: &[Call]) -> Vec<Value> {
    calls.iter().map(|c| c.variables["input"].clone()).collect()
}

fn result(r: &GithubExportResponse) -> Value {
    json_of(r)
}

#[tokio::test]
async fn sends_the_committed_graphql_review_payloads() {
    let github = client(None, Vec::new());
    let threads = vec![
        t("kind").path("tally/ledger.py").lines(3, 4).body("Say what counts as a refund here.").build(),
        t("symbol")
            .path("tally/currency.py")
            .line(7)
            .body("`KWD` has no symbol.\n\n```suggestion\n_SYMBOLS = {\"KWD\": \"KD\"}\n```")
            .build(),
        t("removed").path("tally/legacy.py").old().lines(9, 15).body("Still called by cron.").build(),
        file_thread("module", "Fold this into ledger.py.", "tally/refunds.py"),
        t("gone").path("tally/cli.py").line(27).body("Trips set -e.").stale().build(),
        t("done").path("tally/ledger.py").line(33).body("Already handled.").resolved().build(),
    ];
    let res = export(&github, threads).await.unwrap();
    let mutations: Vec<Value> = github
        .calls()
        .iter()
        .filter(|c| c.query.starts_with("mutation"))
        .map(|c| json!({ "operation": op(&c.query), "input": c.variables["input"] }))
        .collect();
    let payload = json!({ "mutations": mutations, "result": res });
    insta::assert_json_snapshot!(payload);
}

#[tokio::test]
async fn refuses_worktree_export() {
    let github = client(None, Vec::new());
    let err = export_on(&GithubExporter::default(), &github, vec![t("k").build()], None, "worktree").await.unwrap_err();
    assert!(err.message.contains("worktree"), "{err}");
    assert!(github.calls().is_empty());
}

#[tokio::test]
async fn looks_up_the_pending_review_by_owner_repo_and_number() {
    let github = client(None, Vec::new());
    export(&github, vec![t("k").build()]).await.unwrap();
    let calls = github.calls();
    assert_eq!(ops(&calls), ["pending", "createReview"]);
    assert_eq!(calls[0].variables, json!({ "owner": "o", "repo": "r", "number": 7 }));
}

#[tokio::test]
async fn says_how_far_it_got_when_a_file_comment_cannot_be_appended_to_the_review_it_just_created() {
    let failing =
        intercept(None, Vec::new(), |op, _| (op == "addThread").then(|| Err(GithubError::new("GitHub: boom", 502))));
    let err = export(&failing, vec![t("k").build(), file_thread("f", "whole file", "a.txt")]).await.unwrap_err();
    assert!(err.message.starts_with("created the pending review with 1 comments, then "), "{err}");
    assert!(err.message.contains("boom"), "{err}");
}

#[tokio::test]
async fn matches_updates_and_appends_file_comments_in_an_existing_pending_review_by_path() {
    let held = vec![
        existing_file("C_F", "a.txt", "old text\n\n<!-- diffle-thread:f -->"),
        existing_file("C_S", "b.txt", "same\n\n<!-- diffle-thread:s -->"),
        existing("C_L", "a.txt", "RIGHT", 3, "line\n\n<!-- diffle-thread:f -->"),
    ];
    let github = client(Some("PRR_1"), held);
    let threads = vec![
        file_thread("f", "new text", "a.txt"),
        file_thread("s", "same", "b.txt"),
        file_thread("n", "added", "c.txt"),
    ];
    let res = export(&github, threads).await.unwrap();
    assert_eq!(
        result(&res),
        json!({ "url": PR_URL, "posted": 1, "updated": 1, "review": "existing", "skipped": [{ "id": "s", "reason": "already in the review" }] })
    );
    // The line comment carrying f's marker is another anchor: only the file comment is rewritten.
    assert_eq!(
        inputs(&github.calls()[2..]),
        [
            json!({ "pullRequestReviewCommentId": "C_F", "body": "new text\n\n<!-- diffle-thread:f -->" }),
            json!({ "pullRequestReviewId": "PRR_1", "path": "c.txt", "subjectType": "FILE", "body": "added\n\n<!-- diffle-thread:n -->" }),
        ]
    );
}

#[tokio::test]
async fn adds_a_thread_per_comment_to_the_pending_review_the_viewer_already_has() {
    let github = client(Some("PRR_1"), Vec::new());
    let res = export(&github, vec![t("k").build(), t("o").old().lines(5, 8).body("gone").build()]).await.unwrap();
    assert_eq!(result(&res), json!({ "url": PR_URL, "posted": 2, "updated": 0, "review": "existing", "skipped": [] }));
    // The read of what the pending review already holds comes before any write; no new review is created.
    let calls = github.calls();
    assert_eq!(ops(&calls), ["pending", "threads", "addThread", "addThread"]);
    assert_eq!(
        inputs(&calls[2..]),
        [
            json!({ "pullRequestReviewId": "PRR_1", "path": "a.txt", "line": 3, "side": "RIGHT", "body": "hi\n\n<!-- diffle-thread:k -->" }),
            json!({
                "pullRequestReviewId": "PRR_1", "path": "a.txt", "line": 8, "side": "LEFT",
                "body": "gone\n\n<!-- diffle-thread:o -->", "startLine": 5, "startSide": "LEFT",
            }),
        ]
    );
}

#[tokio::test]
async fn leaves_an_identical_comment_already_in_the_pending_review_alone() {
    let github = client(Some("PRR_1"), vec![existing("C_1", "a.txt", "RIGHT", 3, "hi\n\n<!-- diffle-thread:k -->")]);
    let res = export(&github, vec![t("k").build()]).await.unwrap();
    assert_eq!(
        result(&res),
        json!({ "url": PR_URL, "posted": 0, "updated": 0, "review": "existing", "skipped": [{ "id": "k", "reason": "already in the review" }] })
    );
    // Nothing was written: the list is the last call.
    assert_eq!(ops(&github.calls()), ["pending", "threads"]);
}

#[tokio::test]
async fn rewrites_the_comment_in_place_when_the_thread_was_edited_matching_path_side_and_lines() {
    let mut moved = existing("C_2", "a.txt", "LEFT", 8, "gone\n\n<!-- diffle-thread:o -->");
    moved.start_line = Some(5);
    let github = client(
        Some("PRR_1"),
        vec![existing("C_1", "a.txt", "RIGHT", 3, "stale text\n\n<!-- diffle-thread:k -->"), moved],
    );
    let threads = vec![
        t("k").body("hi").build(),
        t("o").old().lines(5, 8).body("gone").build(),
        t("n").line(9).body("new one").build(),
    ];
    let res = export(&github, threads).await.unwrap();
    assert_eq!(
        result(&res),
        json!({ "url": PR_URL, "posted": 1, "updated": 1, "review": "existing", "skipped": [{ "id": "o", "reason": "already in the review" }] })
    );
    assert_eq!(
        inputs(&github.calls()[2..]),
        [
            json!({ "pullRequestReviewCommentId": "C_1", "body": "hi\n\n<!-- diffle-thread:k -->" }),
            json!({ "pullRequestReviewId": "PRR_1", "path": "a.txt", "line": 9, "side": "RIGHT", "body": "new one\n\n<!-- diffle-thread:n -->" }),
        ]
    );
}

#[tokio::test]
async fn side_and_lines_are_part_of_the_identity_a_comment_on_the_other_side_is_not_a_match() {
    let github = client(Some("PRR_1"), vec![existing("C_1", "a.txt", "LEFT", 3, "hi\n\n<!-- diffle-thread:k -->")]);
    let res = export(&github, vec![t("k").build()]).await.unwrap();
    assert_eq!((res.posted, res.updated, res.skipped.len()), (1, 0, 0));
}

#[tokio::test]
async fn two_threads_on_one_line_become_two_comments_the_matched_comment_is_claimed_once() {
    let github = client(Some("PRR_1"), vec![existing("C_1", "a.txt", "RIGHT", 3, "first\n\n<!-- diffle-thread:a -->")]);
    let res = export(&github, vec![t("a").body("first").build(), t("b").body("second").build()]).await.unwrap();
    assert_eq!((res.posted, res.updated), (1, 0));
    assert_eq!(json_of(&res.skipped), json!([{ "id": "a", "reason": "already in the review" }]));
}

#[tokio::test]
async fn leaves_an_untagged_github_draft_on_the_same_lines_untouched() {
    let github = client(Some("PRR_1"), vec![existing("C_1", "a.txt", "RIGHT", 3, "My GitHub draft")]);
    let res = export(&github, vec![t("k").build()]).await.unwrap();
    assert_eq!((res.posted, res.updated), (1, 0));
    assert_eq!(
        inputs(&github.calls()[2..3]),
        [
            json!({ "pullRequestReviewId": "PRR_1", "path": "a.txt", "line": 3, "side": "RIGHT", "body": "hi\n\n<!-- diffle-thread:k -->" })
        ]
    );
}

#[tokio::test]
async fn re_exporting_only_the_second_same_line_thread_updates_only_its_comment() {
    let github = client(
        Some("PRR_1"),
        vec![
            existing("C_A", "a.txt", "RIGHT", 3, "first\n\n<!-- diffle-thread:a -->"),
            existing("C_B", "a.txt", "RIGHT", 3, "second\n\n<!-- diffle-thread:b -->"),
        ],
    );
    let threads = vec![t("a").body("first").build(), t("b").body("edited").build()];
    let res = export_on(&GithubExporter::default(), &github, threads, Some(vec!["b".into()]), &head()).await.unwrap();
    assert_eq!((res.posted, res.updated), (0, 1));
    let calls = github.calls();
    assert_eq!(calls.len(), 3);
    assert_eq!(
        inputs(&calls[2..]),
        [json!({ "pullRequestReviewCommentId": "C_B", "body": "edited\n\n<!-- diffle-thread:b -->" })]
    );
}

#[tokio::test]
async fn finds_an_exported_comment_on_a_later_page_before_deciding_to_add_it() {
    let paginated = intercept(Some("PRR_1"), Vec::new(), |op, vars| {
        if op != "threads" {
            return None;
        }
        let first = vars["after"].is_null();
        let nodes = if first {
            json!([])
        } else {
            thread_nodes(&[existing("C_1", "a.txt", "RIGHT", 3, "hi\n\n<!-- diffle-thread:k -->")], "PRR_1")
        };
        let page = json!({ "nodes": nodes, "pageInfo": { "hasNextPage": first, "endCursor": "page-1" } });
        Some(Ok(json!({ "repository": { "pullRequest": { "reviewThreads": page } } })))
    });
    let res = export(&paginated, vec![t("k").build()]).await.unwrap();
    assert_eq!((res.posted, res.updated), (0, 0));
    assert_eq!(json_of(&res.skipped), json!([{ "id": "k", "reason": "already in the review" }]));
    let calls = paginated.calls();
    assert_eq!(ops(&calls), ["pending", "threads", "threads"]);
    assert_eq!(calls[2].variables["after"], json!("page-1"));
}

#[tokio::test]
async fn does_not_write_after_an_incomplete_lookup() {
    for kind in ["failure", "limit", "missing cursor", "missing data"] {
        let pages = Arc::new(Mutex::new(0));
        let counted = pages.clone();
        let incomplete = intercept(Some("PRR_1"), Vec::new(), move |op, _| {
            if op != "threads" {
                return None;
            }
            let mut pages = counted.lock().unwrap();
            *pages += 1;
            if kind == "failure" && *pages == 2 {
                return Some(Err(GithubError::new("lookup failed", 502)));
            }
            let nodes =
                thread_nodes(&[existing("C_1", "a.txt", "RIGHT", 3, "old\n\n<!-- diffle-thread:k -->")], "PRR_1");
            let cursor = if kind == "missing cursor" { Value::Null } else { json!(format!("page-{pages}")) };
            let review_threads = if kind == "missing data" {
                Value::Null
            } else {
                json!({ "nodes": nodes, "pageInfo": { "hasNextPage": true, "endCursor": cursor } })
            };
            Some(Ok(json!({ "repository": { "pullRequest": { "reviewThreads": review_threads } } })))
        });
        assert!(export(&incomplete, vec![t("k").build()]).await.is_err(), "{kind}");
        assert!(incomplete.calls().iter().all(|c| !c.query.starts_with("mutation")), "{kind}");
        let expected = match kind {
            "limit" => 10,
            "failure" => 2,
            _ => 1,
        };
        assert_eq!(*pages.lock().unwrap(), expected, "{kind}");
    }
}

#[tokio::test]
async fn never_rewrites_a_comment_of_another_review_only_the_pending_reviews_own_count() {
    let submitted = intercept(Some("PRR_1"), Vec::new(), |op, _| {
        (op == "threads").then(|| {
            let nodes = thread_nodes(&[existing("C_1", "a.txt", "RIGHT", 3, "hi")], "PRR_OLD");
            Ok(json!({ "repository": { "pullRequest": { "reviewThreads": { "pageInfo": { "hasNextPage": false }, "nodes": nodes } } } }))
        })
    });
    let res = export(&submitted, vec![t("k").build()]).await.unwrap();
    assert_eq!((res.posted, res.updated, res.skipped.len()), (1, 0, 0));
}

#[tokio::test]
async fn does_not_write_when_the_pending_review_cannot_be_read() {
    let blind = intercept(Some("PRR_1"), Vec::new(), |op, _| {
        (op == "threads").then(|| Err(GithubError::new("GitHub 502: bad gateway", 502)))
    });
    let err = export(&blind, vec![t("k").build()]).await.unwrap_err();
    assert!(err.message.contains("502"), "{err}");
    assert_eq!(ops(&blind.calls()), ["pending"]);
}

#[tokio::test]
async fn ignores_a_pending_review_that_is_not_the_viewers_own() {
    let others = intercept(None, Vec::new(), |op, _| {
        (op == "pending").then(|| {
            let reviews = json!({ "nodes": [{ "id": "PRR_2", "author": { "login": "someone" } }] });
            Ok(json!({ "viewer": { "login": "me" }, "repository": { "pullRequest": { "id": "PR_7", "reviews": reviews } } }))
        })
    });
    let res = export(&others, vec![t("k").build()]).await.unwrap();
    assert_eq!(json_of(&res.review), json!("created"));
}

#[tokio::test]
async fn does_not_create_a_review_when_github_cannot_name_the_pull_request() {
    let nameless = intercept(None, Vec::new(), |op, _| {
        (op == "pending").then(|| Ok(json!({ "viewer": { "login": "me" }, "repository": { "pullRequest": null } })))
    });
    let err = export(&nameless, vec![t("k").build()]).await.unwrap_err();
    assert_eq!(err.status, 502);
    assert!(err.message.contains("cannot read pull request"), "{err}");
    assert_eq!(ops(&nameless.calls()), ["pending"]);
}

#[tokio::test]
async fn overlapping_exports_add_the_same_thread_only_once() {
    let held: Shared = Arc::default();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let entered = Arc::new(Mutex::new(Some(entered_tx)));
    let release = Arc::new(tokio::sync::Notify::new());
    let (writes, gate) = (held.clone(), release.clone());
    let github = FakeGithub::new(move |query: String, _| {
        let (writes, gate, entered) = (writes.clone(), gate.clone(), entered.clone());
        let base = answer(op(&query), Some("PRR_1"), &writes.lock().unwrap());
        async move {
            if op(&query) == "addThread" {
                if let Some(tx) = entered.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                gate.notified().await;
                writes.lock().unwrap().push(existing("C_1", "a.txt", "RIGHT", 3, "hi\n\n<!-- diffle-thread:k -->"));
            }
            Ok(base)
        }
    });
    let exporter = Arc::new(GithubExporter::default());
    let first = tokio::spawn({
        let (exporter, github) = (exporter.clone(), github.clone());
        async move { export_on(&exporter, &github, vec![t("k").build()], None, &head()).await }
    });
    entered_rx.await.unwrap();
    let second = tokio::spawn({
        let (exporter, github) = (exporter.clone(), github.clone());
        async move { export_on(&exporter, &github, vec![t("k").build()], None, &head()).await }
    });
    // Let the second request reach the held write if exports are no longer serialized.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    release.notify_one();
    let first = first.await.unwrap().unwrap();
    // A second write would wait on the gate too; release it so a broken queue fails the count, not the test's clock.
    release.notify_one();
    let second = second.await.unwrap().unwrap();
    assert_eq!(first.posted, 1);
    assert_eq!(second.posted, 0);
    assert_eq!(json_of(&second.skipped), json!([{ "id": "k", "reason": "already in the review" }]));
    assert_eq!(held.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_failed_export_does_not_block_the_next_export() {
    let github = client(None, Vec::new());
    let exporter = GithubExporter::default();
    let sha = head();
    let (failed, next) = tokio::join!(
        export_on(&exporter, &github, vec![t("s").stale().build()], None, &sha),
        export_on(&exporter, &github, vec![t("k").build()], None, &sha),
    );
    assert!(failed.unwrap_err().message.contains("nothing to post"));
    assert_eq!(next.unwrap().posted, 1);
}

#[tokio::test]
async fn reports_completed_writes_when_an_append_fails() {
    for (updates, additions) in [(0, 1), (1, 0), (1, 1)] {
        let held = if updates > 0 {
            vec![existing("C_1", "a.txt", "RIGHT", 3, "old\n\n<!-- diffle-thread:k -->")]
        } else {
            Vec::new()
        };
        let added = Arc::new(Mutex::new(0));
        let github = intercept(Some("PRR_1"), held, move |op, _| {
            if op != "addThread" {
                return None;
            }
            let mut added = added.lock().unwrap();
            let fail = *added == additions;
            *added += 1;
            fail.then(|| Err(GithubError::new("line outside the diff", 502)))
        });
        let err =
            export(&github, vec![t("k").build(), t("a").line(8).build(), t("b").line(9).build()]).await.unwrap_err();
        assert_eq!(err.status, 502);
        let message = format!(
            "updated {updates} and added {additions} comments in the pending review, then line outside the diff"
        );
        assert_eq!(err.message, message);
    }
}

#[tokio::test]
async fn reports_completed_updates_when_a_later_update_fails() {
    let held = vec![
        existing("C_1", "a.txt", "RIGHT", 3, "old\n\n<!-- diffle-thread:k -->"),
        existing("C_2", "a.txt", "RIGHT", 8, "old\n\n<!-- diffle-thread:a -->"),
    ];
    let updated = Arc::new(Mutex::new(0));
    let github = intercept(Some("PRR_1"), held, move |op, _| {
        if op != "updateComment" {
            return None;
        }
        let mut updated = updated.lock().unwrap();
        *updated += 1;
        (*updated == 2).then(|| Err(GithubError::new("update failed", 502)))
    });
    let err = export(&github, vec![t("k").build(), t("a").line(8).build()]).await.unwrap_err();
    assert_eq!(
        (err.status, err.message.as_str()),
        (502, "updated 1 and added 0 comments in the pending review, then update failed")
    );
}

#[tokio::test]
async fn answers_400_when_every_thread_is_skipped() {
    let err = export(&client(None, Vec::new()), vec![t("s").stale().build()]).await.unwrap_err();
    assert_eq!(err.status, 400);
    assert!(err.message.contains("1 stale"), "{err}");
}
