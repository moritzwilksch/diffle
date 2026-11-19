//! Threads as a pending GitHub review: building it, and creating or merging into the viewer's draft.
use crate::common;

use std::sync::{Arc, Mutex};

use common::github::{Call, FakeGithub};
use diffle::error::{Error, GithubError};
use diffle::github::client::GithubClient;
use diffle::github::pulls::repo_of_pr_url;
use diffle::github::review::{ExportInput, GithubExporter, build_review, format_body};
use diffle::protocol::{
    CommentAnchor, CommentAuthor, CommentMessage, CommentThread, GithubExportResponse, GithubPullRequest,
    GithubPullRequestState, Side, TourCommentTag, TourPart, TourTarget,
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
        messages: vec![CommentMessage {
            id: format!("{id}-m"),
            body: body.into(),
            created_at: 1,
            updated_at: 1,
            author: None,
        }],
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
fn build_review_skips_threads_on_the_tour() {
    let target = TourTarget::Element { label: "Session".into() };
    let element = TourPart { tag: TourCommentTag::P, handle: None };
    let anchor =
        CommentAnchor::Tour { node: vec![3], step: Some(1), section: "S".into(), element, within: None, target };
    let built = build_review(&[thread_with("tour", anchor, "why?", false, false), t("k").build()], None);
    assert_eq!(built.ids, ["k"]);
    let skipped = json!([{ "id": "tour", "reason": "a comment on the tour has no place in a pull request review" }]);
    assert_eq!(json_of(&built.skipped), skipped);
}

#[test]
fn build_review_with_ids_posts_the_named_threads_resolved_included_and_reports_unknown_ids() {
    let ids = ["r".to_owned(), "nope".to_owned()];
    let built = build_review(&[t("r").resolved().body("done").build(), t("k").build()], Some(&ids));
    assert_eq!(built.comments.iter().map(|c| c.body.as_str()).collect::<Vec<_>>(), ["done"]);
    assert_eq!(json_of(&built.skipped), json!([{ "id": "nope", "reason": "unknown thread" }]));
}

#[test]
fn build_review_posts_agent_messages_like_the_reviewers_without_a_prefix() {
    let mut opened = file_thread("a", "Split this module.", "a.txt");
    opened.messages[0].author = Some(CommentAuthor::Agent);
    let mut answered = t("r").body("Why here?").build();
    answered.messages.push(CommentMessage {
        id: "r-m2".into(),
        body: "It keeps the parser pure.".into(),
        created_at: 2,
        updated_at: 2,
        author: Some(CommentAuthor::Agent),
    });
    let built = build_review(&[opened, answered], None);
    assert!(built.skipped.is_empty());
    assert_eq!(
        json_of(&built.comments),
        json!([
            { "path": "a.txt", "subjectType": "FILE", "body": "Split this module." },
            { "path": "a.txt", "line": 3, "side": "RIGHT", "body": "Why here?\n\n---\n\nIt keeps the parser pure." },
        ])
    );
}

#[test]
fn format_body_joins_messages_and_keeps_suggestion_fences_verbatim() {
    let body = format_body(&[
        CommentMessage { id: "1".into(), body: "Batch this.".into(), created_at: 1, updated_at: 1, author: None },
        CommentMessage {
            id: "2".into(),
            body: "```suggestion\nfoo()\n```".into(),
            created_at: 2,
            updated_at: 2,
            author: None,
        },
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

#[tokio::test]
async fn sends_a_pr_draft_to_github_without_exporting_or_storing_local_threads() {
    use diffle::protocol::{GithubCommentRequest, ThreadQuery};

    let fixture = common::pr::Fixture::new();
    let github = pr_review_client(&fixture, None);
    let (session, snap) = start_pr_session(&fixture, &github).await;
    let store = session.comments().unwrap();
    let local = store.add_thread(CommentAnchor::File { path: "a.txt".into() }, "Local note".into()).await.unwrap();
    github.clear();

    let request = |version| -> GithubCommentRequest {
        serde_json::from_value(json!({
            "version": version,
            "id": "47412657-64b1-4e44-982b-03f98da99cb1",
            "comment": { "path": "a.txt", "startLine": 2, "body": "GitHub note" }
        }))
        .unwrap()
    };
    assert!(session.send_github_comment(request(snap.version - 1)).await.is_err());
    assert!(github.calls().is_empty());
    let response = session.send_github_comment(request(snap.version)).await.unwrap();
    assert_eq!(response.posted, 1);
    let calls = github.calls();
    let write = calls.iter().find(|call| op(&call.query) == "createReview").unwrap();
    let comments = write.variables["input"]["threads"].as_array().unwrap();
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0]["path"], "a.txt");
    assert_eq!(comments[0]["line"], 2);
    assert!(comments[0]["body"].as_str().unwrap().starts_with("GitHub note\n\n"));
    let threads = store.threads(&ThreadQuery { path: None, state: None }).await.unwrap();
    assert_eq!(threads.into_iter().map(|thread| thread.id).collect::<Vec<_>>(), [local.id]);
    session.close().await;
}

fn pr_review_client(fixture: &common::pr::Fixture, pending: Option<&'static str>) -> FakeGithub {
    let node = fixture.node(json!({ "headRefOid": fixture.head }));
    FakeGithub::new(move |query, _| {
        let result = if query.contains("headRefOid") {
            json!({ "repository": { "pullRequest": node } })
        } else if query.contains("submitPullRequestReview") {
            json!({ "submitPullRequestReview": { "pullRequestReview": { "id": "PRR_SUBMITTED" } } })
        } else {
            answer(op(&query), pending, &[])
        };
        async move { Ok(result) }
    })
}

async fn start_pr_session(
    fixture: &common::pr::Fixture,
    github: &FakeGithub,
) -> (Arc<diffle::session::Session>, Arc<diffle::protocol::Snapshot>) {
    use diffle::github::hosts::{Github, GithubInstance};
    use diffle::protocol::{EnterRequest, FollowRefs};
    use diffle::server::hub::Hub;
    use diffle::session::{Session, SessionOptions};

    let session = Session::new(
        Arc::new(fixture.repo().await),
        Hub::new(),
        SessionOptions {
            watch: false,
            github: Github { instance: GithubInstance::github_com(), client: Some(Arc::new(github.clone())) },
            context: 3,
            follow_refs: FollowRefs::Off,
            instance: "pr-review".into(),
            checkout: false,
        },
    );
    let review = session.resolve(EnterRequest::Pr { pr: Some(PR_URL.into()) }).await.unwrap();
    let snap = session.start(review).await.unwrap();
    (session, snap)
}

struct ViewerFiles {
    pr: Value,
    state: &'static str,
    advanced_before_write: bool,
    offline: bool,
}

fn viewed_client(files: Arc<Mutex<ViewerFiles>>) -> FakeGithub {
    FakeGithub::new(move |query, variables| {
        let files = files.clone();
        async move {
            let mut files = files.lock().unwrap();
            let refs = json!({ "headRefOid": files.pr["headRefOid"], "baseRefOid": files.pr["baseRefOid"] });
            if query.starts_with("mutation") {
                assert_eq!(variables["input0"], json!({ "pullRequestId": "PR_7", "path": "a.txt" }));
                files.state = if query.contains(":markFileAsViewed") { "VIEWED" } else { "UNVIEWED" };
                return Ok(json!({ "file0": { "pullRequest": refs } }));
            }
            if query.contains("viewerViewedState") {
                if files.offline {
                    return Err(GithubError::new("GitHub unavailable", 502));
                }
                let second = !variables["after"].is_null();
                if second {
                    assert_eq!(variables["after"], "next");
                }
                let mut pr = files.pr.clone();
                pr["id"] = json!("PR_7");
                pr["files"] = json!({
                    "nodes": [{ "path": if second { "a.txt" } else { "missing.txt" }, "viewerViewedState": files.state }],
                    "pageInfo": { "hasNextPage": !second, "endCursor": (!second).then_some("next") },
                });
                return Ok(json!({ "repository": { "pullRequest": pr } }));
            }
            if query.contains("node(id:") {
                let mut refs = refs;
                if files.advanced_before_write {
                    refs["headRefOid"] = json!("another-head");
                }
                return Ok(json!({ "node": refs }));
            }
            Ok(json!({ "repository": { "pullRequest": files.pr } }))
        }
    })
}

#[tokio::test]
async fn syncs_viewed_marks_with_github_and_reads_them_again_at_the_refreshed_head() {
    use diffle::protocol::ViewedEntry;

    let fixture = common::pr::Fixture::new();
    let remote = Arc::new(Mutex::new(ViewerFiles {
        pr: fixture.node(json!({ "headRefOid": fixture.head })),
        state: "VIEWED",
        advanced_before_write: false,
        offline: false,
    }));
    let github = viewed_client(remote.clone());
    let (session, initial) = start_pr_session(&fixture, &github).await;
    let viewed = ViewedEntry { path: "a.txt".into(), blob: initial.changed[0].blob.clone(), viewed: true };
    assert_eq!(session.viewed_marks().await.unwrap().as_slice(), std::slice::from_ref(&viewed));

    let unviewed = ViewedEntry { viewed: false, ..viewed.clone() };
    assert_eq!(session.set_viewed_mark(unviewed.clone()).await.unwrap().as_slice(), std::slice::from_ref(&unviewed));
    assert_eq!(remote.lock().unwrap().state, "UNVIEWED");
    assert_eq!(session.viewed_marks().await.unwrap(), [unviewed]);
    assert_eq!(session.set_viewed_marks(vec![viewed.clone()]).await.unwrap().as_slice(), std::slice::from_ref(&viewed));
    assert_eq!(remote.lock().unwrap().state, "VIEWED");

    // A push between the file lookup and the write's final head check cannot mark the new file.
    github.clear();
    remote.lock().unwrap().advanced_before_write = true;
    assert!(matches!(session.set_viewed_mark(viewed.clone()).await, Err(Error::Github(_))));
    assert!(github.calls().iter().all(|call| !call.query.starts_with("mutation")));

    common::git_in(&fixture.origin, &["checkout", "--detach", &fixture.head]);
    std::fs::write(fixture.origin.join("a.txt"), "one\ntwo\nnew change\n").unwrap();
    common::git_in(&fixture.origin, &["commit", "-qam", "new PR change"]);
    let head = common::git_in(&fixture.origin, &["rev-parse", "HEAD"]);
    common::git_in(&fixture.origin, &["update-ref", "refs/pull/7/head", &head]);
    remote.lock().unwrap().pr["headRefOid"] = json!(head);
    remote.lock().unwrap().advanced_before_write = false;
    remote.lock().unwrap().state = "DISMISSED";
    github.clear();
    assert!(matches!(session.set_viewed_mark(viewed.clone()).await, Err(Error::Github(_))));
    assert!(github.calls().iter().all(|call| !call.query.starts_with("mutation")));

    let refreshed = session.reload().await.unwrap();
    assert_eq!(refreshed.new_sha, head);
    assert_ne!(refreshed.changed[0].blob, viewed.blob);
    assert_eq!(session.viewed_marks().await.unwrap().as_slice(), std::slice::from_ref(&viewed));
    remote.lock().unwrap().state = "VIEWED";
    let fresh = ViewedEntry { blob: refreshed.changed[0].blob.clone(), ..viewed.clone() };
    let entries = session.viewed_marks().await.unwrap();
    assert!(entries.contains(&fresh));

    remote.lock().unwrap().offline = true;
    assert_eq!(session.viewed_marks().await.unwrap(), [viewed]);
    session.close().await;
}

#[tokio::test]
async fn submits_review_decisions_to_the_viewers_pending_review_or_the_reviewed_commit() {
    use diffle::protocol::{GithubReviewDecision as Decision, GithubReviewSubmit};

    for (pending, decision, summary, event) in [
        (Some("PRR_MINE"), Decision::Comment, "", "COMMENT"),
        (None, Decision::Comment, "General feedback", "COMMENT"),
        (None, Decision::Approve, "", "APPROVE"),
        (Some("PRR_MINE"), Decision::RequestChanges, "Please add a test", "REQUEST_CHANGES"),
    ] {
        let fixture = common::pr::Fixture::new();
        let github = pr_review_client(&fixture, pending);
        let (session, snap) = start_pr_session(&fixture, &github).await;
        let request =
            |version, decision, summary: &str| GithubReviewSubmit { version, decision, summary: summary.into() };
        github.clear();
        assert!(session.submit_github_review(request(snap.version - 1, decision, summary)).await.is_err());
        assert!(github.calls().is_empty());

        assert!(session.submit_github_review(request(snap.version, Decision::RequestChanges, " ")).await.is_err());
        if pending.is_none() {
            assert!(session.submit_github_review(request(snap.version, Decision::Comment, "")).await.is_err());
        }
        assert!(github.calls().iter().all(|call| !call.query.starts_with("mutation")));
        github.clear();

        session.submit_github_review(request(snap.version, decision, summary)).await.unwrap();
        let calls = github.calls();
        let writes: Vec<_> = calls.iter().filter(|call| call.query.starts_with("mutation")).collect();
        assert_eq!(writes.len(), 1);
        let input = &writes[0].variables["input"];
        assert_eq!(input["event"], event);
        assert_eq!(input["body"], if summary.is_empty() { Value::Null } else { json!(summary) });
        if let Some(id) = pending {
            assert!(writes[0].query.contains("submitPullRequestReview"));
            assert_eq!(input["pullRequestReviewId"], id);
        } else {
            assert!(writes[0].query.contains("addPullRequestReview"));
            assert_eq!(input["pullRequestId"], "PR_7");
            assert_eq!(input["commitOID"], fixture.head);
        }
        session.close().await;
    }
}

#[tokio::test]
async fn reads_resolved_and_outdated_threads_all_replies_and_general_discussion() {
    use diffle::github::comments::read;
    use diffle::protocol::PullRef;

    fn page(nodes: Value, next: Option<&str>) -> Value {
        json!({"nodes": nodes, "pageInfo": {"hasNextPage": next.is_some(), "endCursor": next}})
    }
    fn msg(id: &str, author: Value) -> Value {
        json!({"id": id, "body": id, "createdAt": "2026-01-01T12:00:00Z", "url": PR_URL, "author": author})
    }

    let github = FakeGithub::new(move |query, vars| async move {
        let author = json!({"login": "reviewer"});
        if query.contains("node(id:") {
            assert_eq!(vars, json!({"id":"thread", "after":"more-replies"}));
            return Ok(json!({"node":{"comments":page(json!([msg("reply-2", Value::Null)]), None)}}));
        }
        let (field, connection) = if query.contains("reviewThreads") {
            if vars["after"] == "more-threads" {
                ("reviewThreads", page(json!([]), None))
            } else {
                (
                    "reviewThreads",
                    page(
                        json!([{
                            "id":"thread", "path":"a.txt", "line":null, "startLine":null, "originalLine":7,
                            "originalStartLine":6, "diffSide":"LEFT", "isResolved":true, "isOutdated":true,
                            "pullRequest":{"headRefOid":"pr-head"}, "viewerCanReply":true,
                            "viewerCanResolve":false, "viewerCanUnresolve":true,
                            "replies":page(json!([msg("first", author)]), Some("more-replies"))
                        }]),
                        Some("more-threads"),
                    ),
                )
            }
        } else if query.contains("reviews(") {
            ("reviews", page(json!([msg("summary", author)]), None))
        } else {
            ("comments", page(json!([msg("general", author)]), None))
        };
        Ok(json!({"repository":{"pullRequest":{(field):connection}}}))
    });
    let pr = PullRef { number: 7, url: PR_URL.into(), repository: "o/r".into(), head_repository: None };
    let comments = read(&github, &pr).await.unwrap();
    let thread = &comments.threads[0];
    assert!(thread.is_resolved && thread.is_outdated);
    assert!(thread.viewer_can_reply && !thread.viewer_can_resolve && thread.viewer_can_unresolve);
    assert_eq!(thread.pull_request.head_ref_oid, "pr-head");
    assert_eq!(thread.original_line, Some(7));
    assert_eq!(thread.comments.iter().map(|comment| comment.id.as_str()).collect::<Vec<_>>(), ["first", "reply-2"]);
    assert_eq!(thread.comments[1].author, "Deleted user");
    assert_eq!(
        comments.conversation.iter().map(|comment| comment.id.as_str()).collect::<Vec<_>>(),
        ["general", "summary"]
    );
}

#[tokio::test]
async fn pending_comment_deletion_requires_the_viewer_to_own_the_draft_on_this_pr() {
    use diffle::github::comments::pending_comment_id;
    for (state, author, can_delete, url, allowed) in [
        ("PENDING", true, true, PR_URL, true),
        ("PUBLISHED", true, true, PR_URL, false),
        ("PENDING", false, true, PR_URL, false),
        ("PENDING", true, false, PR_URL, false),
        ("PENDING", true, true, "https://github.com/o/r/pull/8", false),
    ] {
        let github = FakeGithub::new(move |query, variables| async move {
            assert!(query.contains("PullRequestReviewComment"));
            assert_eq!(variables, json!({"id":"PRRC_a"}));
            Ok(json!({"node": {
                "databaseId":42, "state":state, "viewerDidAuthor":author, "viewerCanDelete":can_delete,
                "pullRequest":{"url":url}
            }}))
        });
        let result = pending_comment_id(&github, PR_URL, "PRRC_a").await;
        if allowed {
            assert_eq!(result.unwrap(), 42);
        } else {
            assert_eq!(result.unwrap_err().status, 409);
        }
    }
}

#[tokio::test]
async fn pending_comment_edits_require_ownership_and_preserve_the_export_marker() {
    use diffle::github::comments::pending_comment_edit;
    for (state, author, permission, url, allowed) in [
        ("PENDING", true, true, PR_URL, true),
        ("SUBMITTED", true, true, PR_URL, false),
        ("PENDING", false, true, PR_URL, false),
        ("PENDING", true, false, PR_URL, false),
        ("PENDING", true, true, "https://github.com/o/r/pull/8", false),
    ] {
        let github = FakeGithub::new(move |query, variables| async move {
            assert!(query.contains("viewerCanUpdate"));
            assert_eq!(variables, json!({"id":"PRRC_a"}));
            Ok(json!({"node": {
                "body":"Old draft\n\n<!-- diffle-thread:one%20two -->",
                "state":state, "viewerDidAuthor":author, "viewerCanUpdate":permission, "pullRequest":{"url":url}
            }}))
        });
        let result = pending_comment_edit(&github, PR_URL, "PRRC_a", "New draft").await;
        if allowed {
            assert_eq!(result.unwrap(), "New draft\n\n<!-- diffle-thread:one%20two -->");
        } else {
            assert_eq!(result.unwrap_err().status, 409);
        }
    }
}
