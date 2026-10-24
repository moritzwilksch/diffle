//! Links to lines on origin's GitHub, judged from local refs: which sides it can show, and how.
mod common;

use std::sync::Arc;

use common::github::FakeGithub;
use common::pr::{Fixture, as_git_url};
use common::server::TestServer;
use common::{TestRepo, git_in, revspec};
use diffle::git::GitRepo;
use diffle::github::client::GithubClient;
use diffle::github::hosts::{Github, GithubInstance};
use diffle::github::permalink::permalink;
use diffle::mode::resolve::resolve_review;
use diffle::protocol::{EnterRequest, Permalink, PermalinkRequest, Side, Snapshot};
use diffle::snapshotter::Snapshotter;

async fn link(repo: &GitRepo, snap: &Snapshot, path: &str, side: Side, lines: (i64, i64)) -> Permalink {
    let req =
        PermalinkRequest { version: snap.version, path: path.into(), side, start_line: lines.0, end_line: lines.1 };
    permalink(repo, snap, &Github::tokenless().instance, &req).await.unwrap()
}

/// Whether (old, new) have a link, read without a token.
async fn published(repo: &Arc<GitRepo>, snap: &Snapshot) -> (bool, bool) {
    let has = async |side| link(repo, snap, "a.txt", side, (1, 1)).await.url.is_some();
    (has(Side::Old).await, has(Side::New).await)
}

async fn sides(repo: &Arc<GitRepo>, req: EnterRequest) -> (bool, bool) {
    let (_, snap) = common::snapshot(repo, req).await;
    published(repo, &snap).await
}

/// `main` with a pushed commit, an unpushed one on top, and an uncommitted edit; origin reads as
/// github.com/o/r and its remote-tracking branch stands for the push.
fn pushed_then_local() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("base");
    t.write("a.txt", "one\ntwo\n");
    t.commit("pushed");
    t.git(&["remote", "add", "origin", "https://github.com/o/r"]);
    // Nested, like a branch with a slash in its name.
    t.git(&["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    t.write("a.txt", "one\ntwo\nthree\n");
    t.commit("local");
    t.write("a.txt", "one\ntwo\nthree\nfour\n");
    t
}

#[tokio::test]
async fn publishes_commits_a_remote_tracking_branch_of_origin_reaches_and_never_the_worktree() {
    let t = pushed_then_local();
    let repo = Arc::new(t.open().await);
    let cases = [
        ("pushed^!", sides(&repo, revspec(&["HEAD~1^!"])).await),
        ("pushed..local", sides(&repo, revspec(&["HEAD~1", "HEAD"])).await),
        ("local^!", sides(&repo, revspec(&["HEAD^!"])).await),
        ("pushed..worktree", sides(&repo, revspec(&["HEAD~1"])).await),
        ("working", sides(&repo, EnterRequest::Working).await),
    ];
    assert_eq!(
        cases,
        [
            ("pushed^!", (true, true)),
            ("pushed..local", (true, false)),
            ("local^!", (true, false)),
            ("pushed..worktree", (true, false)),
            ("working", (false, false)),
        ]
    );
    // Pushing the local commit publishes it.
    t.git(&["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    assert_eq!(sides(&repo, revspec(&["HEAD~1", "HEAD"])).await, (true, true));
    assert_eq!(sides(&repo, EnterRequest::Working).await, (true, false));
}

#[tokio::test]
async fn links_a_sides_lines_at_its_commit_an_old_side_at_the_renames_old_path_escaped() {
    let t = TestRepo::new();
    t.write("src/old#name.ts", "one\ntwo\n");
    t.commit("base");
    t.git(&["mv", "src/old#name.ts", "src/new name.ts"]);
    t.commit("rename");
    t.git(&["remote", "add", "origin", "git@github.com:o/r.git"]);
    t.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let repo = Arc::new(t.open().await);
    let (_, snap) = common::snapshot(&repo, revspec(&["HEAD^!"])).await;
    let url = async |side, lines| link(&repo, &snap, "src/new name.ts", side, lines).await.url.unwrap();
    assert_eq!(
        [url(Side::New, (4, 4)).await, url(Side::Old, (2, 5)).await],
        [
            format!("https://github.com/o/r/blob/{}/src/new%20name.ts#L4", snap.new_sha),
            format!("https://github.com/o/r/blob/{}/src/old%23name.ts#L2-L5", snap.old_sha),
        ]
    );
}

#[tokio::test]
async fn says_why_there_is_no_link() {
    let t = pushed_then_local();
    let repo = Arc::new(t.open().await);
    let (_, local) = common::snapshot(&repo, revspec(&["HEAD~1", "HEAD"])).await;
    let (_, working) = common::snapshot(&repo, EnterRequest::Working).await;
    let why = async |snap: &Snapshot| link(&repo, snap, "a.txt", Side::New, (1, 1)).await.reason.unwrap();
    // Lines read from the snapshot before this one.
    let stale = PermalinkRequest {
        version: local.version - 1,
        path: "a.txt".into(),
        side: Side::New,
        start_line: 1,
        end_line: 1,
    };
    let stale = permalink(&repo, &local, &Github::tokenless().instance, &stale).await.unwrap().reason.unwrap();
    let reasons = [stale, why(&local).await, why(&working).await];
    t.git(&["remote", "set-url", "origin", "https://gitlab.com/o/r"]);
    assert_eq!(
        [reasons.as_slice(), &[why(&local).await]].concat(),
        [
            "The review changed; try again",
            "Not on GitHub: these lines are not in a pushed commit",
            "Uncommitted lines have no GitHub link",
            "No GitHub origin to link to",
        ]
    );
}

#[tokio::test]
async fn serves_a_push_on_the_next_request_without_a_reload() {
    let s = TestServer::over(pushed_then_local(), revspec(&["HEAD~1", "HEAD"])).await;
    let snap = s.get("/api/snapshot").await.json();
    let req =
        serde_json::json!({ "version": snap["version"], "path": "a.txt", "side": "new", "startLine": 3, "endLine": 3 });
    let link = async || s.json("POST", "/api/permalink", req.clone()).await.json();
    assert_eq!(
        link().await,
        serde_json::json!({ "url": null, "reason": "Not on GitHub: these lines are not in a pushed commit" })
    );
    s.repo.git(&["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    let url = format!("https://github.com/o/r/blob/{}/a.txt#L3", snap["newSha"].as_str().unwrap());
    assert_eq!(link().await, serde_json::json!({ "url": url, "reason": null }));
    s.close().await;
}

#[tokio::test]
async fn publishes_nothing_without_a_github_origin_or_from_another_remote() {
    let t = pushed_then_local();
    let repo = Arc::new(t.open().await);
    // Another remote's branches do not make a commit visible in origin's repository.
    t.git(&["remote", "add", "upstream", "https://github.com/up/r"]);
    t.git(&["update-ref", "refs/remotes/upstream/main", "HEAD"]);
    assert_eq!(sides(&repo, revspec(&["HEAD~1", "HEAD"])).await, (true, false));
    t.git(&["remote", "set-url", "origin", "https://gitlab.com/o/r"]);
    assert_eq!(sides(&repo, revspec(&["HEAD~1^!"])).await, (false, false));
}

fn with(client: &FakeGithub) -> Github {
    let client = Some(Arc::new(client.clone()) as Arc<dyn GithubClient>);
    Github { instance: GithubInstance::github_com(), client }
}

async fn pr_sides(repo: &Arc<GitRepo>, f: &Fixture) -> (bool, bool) {
    let review = resolve_review(&EnterRequest::Pr { pr: Some("7".into()) }, repo, &with(&f.github())).await.unwrap();
    let key = common::range_key(repo, &review).await;
    let snap = Snapshotter::new(repo.clone(), review, key, 1, 3, None).current().await.unwrap();
    let sides = published(repo, &snap).await;
    repo.clean_review_refs().await.unwrap();
    sides
}

#[tokio::test]
async fn publishes_a_pull_requests_head_through_the_refs_this_run_fetched_it_into() {
    let f = Fixture::new();
    let repo = Arc::new(f.repo().await);
    // The clone never saw the head; only the fetch into this run's refs brings it.
    assert_eq!(pr_sides(&repo, &f).await, (true, true));
}

#[tokio::test]
async fn publishes_no_pull_request_head_fetched_from_a_repository_other_than_origins() {
    let f = Fixture::new();
    // A fork's clone: origin is the fork, the pull request lives upstream.
    let forked = f.root().join("forked");
    git_in(&f.root(), &["clone", "-q", "--origin", "upstream", &as_git_url(&f.origin), &as_git_url(&forked)]);
    f.point_remote_at_github(&forked, "upstream");
    git_in(&forked, &["remote", "add", "origin", "https://github.com/me/r"]);
    git_in(&forked, &["update-ref", "refs/remotes/origin/main", &f.merge_base]);
    let repo = Arc::new(GitRepo::open(&forked).await.unwrap());
    assert_eq!(pr_sides(&repo, &f).await, (true, false));
}
