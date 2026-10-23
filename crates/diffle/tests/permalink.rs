//! Which sides of a review GitHub can show, judged from local refs: what permalinks need.
mod common;

use std::sync::Arc;

use common::github::FakeGithub;
use common::pr::{Fixture, as_git_url};
use common::server::TestServer;
use common::{TestRepo, git_in, revspec};
use diffle::git::GitRepo;
use diffle::github::client::GithubClient;
use diffle::github::hosts::{Github, GithubInstance};
use diffle::github::published::published as read_published;
use diffle::mode::resolve::resolve_review;
use diffle::protocol::{EnterRequest, Snapshot};
use diffle::snapshotter::Snapshotter;

/// (old, new) published, read without a token.
async fn published(repo: &Arc<GitRepo>, snap: &Snapshot) -> (bool, bool) {
    let p = read_published(repo, snap, &Github::tokenless().instance).await.unwrap();
    (p.old, p.new)
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
async fn serves_a_push_on_the_next_request_without_a_reload() {
    let s = TestServer::over(pushed_then_local(), revspec(&["HEAD~1", "HEAD"])).await;
    let version = s.get("/api/snapshot").await.json()["version"].clone();
    let published = async || s.get("/api/github/published").await.json();
    let expected = |new: bool| serde_json::json!({ "version": version, "repositoryUrl": "https://github.com/o/r", "old": true, "new": new });
    assert_eq!(published().await, expected(false));
    s.repo.git(&["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    assert_eq!(published().await, expected(true));
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
