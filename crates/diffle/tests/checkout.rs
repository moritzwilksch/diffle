//! Entering a branch or a pull request checks it out when the worktree is clean, so language
//! servers see the new side.
mod common;

use std::sync::Arc;

use common::pr::Fixture;
use common::{Recorder, TestRepo, revspec};
use diffle::git::GitRepo;
use diffle::github::client::GithubClient;
use diffle::github::hosts::{Github, GithubInstance};
use diffle::protocol::{EnterRequest, FollowRefs, follows_checkout};
use diffle::session::{Session, SessionOptions};

fn session(repo: GitRepo, github: Github, checkout: bool) -> Arc<Session> {
    let opts = SessionOptions { watch: false, github, context: 3, follow_refs: FollowRefs::Off, checkout };
    Session::new(Arc::new(repo), Arc::new(Recorder::default()), opts)
}

/// main with one commit, and `feat` one commit ahead of it; HEAD on main.
fn branches() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("a.txt", "one\ntwo\n");
    t.commit("feat");
    t.git(&["checkout", "-q", "main"]);
    t
}

fn head(t: &TestRepo) -> String {
    t.git(&["rev-parse", "--abbrev-ref", "HEAD"])
}

#[tokio::test]
async fn switches_to_a_local_branch_on_the_new_side() {
    let t = branches();
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "feat");
    assert!(follows_checkout(&snap), "the snapshot sees its new side checked out");
    // Untracked files ride along; a later review back on main switches again.
    t.write("scratch.txt", "x\n");
    let snap = s.enter(revspec(&["feat..main"])).await.unwrap();
    assert_eq!(head(&t), "main");
    assert!(follows_checkout(&snap));
    assert!(t.path.join("scratch.txt").exists());
}

#[tokio::test]
async fn detaches_at_a_remote_branch() {
    let t = branches();
    let feat = t.git(&["rev-parse", "feat"]);
    t.git(&["update-ref", "refs/remotes/origin/feat", &feat]);
    t.git(&["branch", "-q", "-D", "feat"]);
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...origin/feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "HEAD");
    assert_eq!(t.git(&["rev-parse", "HEAD"]), feat);
}

#[tokio::test]
async fn leaves_a_dirty_worktree_alone() {
    let t = branches();
    t.write("a.txt", "edited\n");
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "main");
    assert!(!follows_checkout(&snap), "no language servers without the checkout");
    assert_eq!(std::fs::read_to_string(t.path.join("a.txt")).unwrap(), "edited\n");
    // A staged change counts as dirty too.
    t.git(&["add", "a.txt"]);
    s.enter(revspec(&["main...feat"])).await.unwrap();
    assert_eq!(head(&t), "main");
}

#[tokio::test]
async fn detaches_at_a_commit_a_tag_or_an_expression() {
    let t = branches();
    let (main, feat) = (t.git(&["rev-parse", "main"]), t.git(&["rev-parse", "feat"]));
    t.git(&["tag", "v1", "main"]);
    let s = session(t.open().await, Github::tokenless(), true);
    let at = |t: &TestRepo| (head(t), t.git(&["rev-parse", "HEAD"]));
    let snap = s.start(s.resolve(revspec(&["feat^!"])).await.unwrap()).await.unwrap();
    assert_eq!(at(&t), ("HEAD".to_owned(), feat.clone()));
    assert!(follows_checkout(&snap), "the lone commit is the checkout");
    s.enter(revspec(&["feat..v1"])).await.unwrap();
    assert_eq!(at(&t), ("HEAD".to_owned(), main.clone()));
    s.enter(revspec(&["main..feat~0"])).await.unwrap();
    assert_eq!(at(&t), ("HEAD".to_owned(), feat));
    // The uncommitted changes are the checkout already.
    s.enter(EnterRequest::Working).await.unwrap();
    assert_eq!(head(&t), "HEAD");
    s.close().await;
    assert_eq!(head(&t), "main");
}

#[tokio::test]
async fn stays_put_when_turned_off() {
    let t = branches();
    let s = session(t.open().await, Github::tokenless(), false);
    s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "main");
}

#[tokio::test]
async fn detaches_at_a_pull_requests_head() {
    let f = Fixture::new();
    let github =
        Github { instance: GithubInstance::github_com(), client: Some(Arc::new(f.github()) as Arc<dyn GithubClient>) };
    let s = session(f.repo().await, github, true);
    let snap = s.start(s.resolve(EnterRequest::Pr { pr: Some("7".into()) }).await.unwrap()).await.unwrap();
    let git = |args: &[&str]| common::git_in(&f.local, args);
    assert_eq!(git(&["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
    assert_eq!(git(&["rev-parse", "HEAD"]), f.head);
    assert!(follows_checkout(&snap));
}

#[tokio::test]
async fn detaches_at_a_branch_another_worktree_holds() {
    let t = branches();
    let feat = t.git(&["rev-parse", "feat"]);
    let other = tempfile::tempdir().unwrap();
    t.git(&["worktree", "add", "-q", &other.path().join("feat").to_string_lossy(), "feat"]);
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!((head(&t), t.git(&["rev-parse", "HEAD"])), ("HEAD".to_owned(), feat));
    assert!(follows_checkout(&snap));
}

#[tokio::test]
async fn leaves_the_checkout_alone_when_git_refuses() {
    let t = branches();
    // An untracked file the switch would overwrite.
    t.git(&["checkout", "-q", "feat"]);
    t.write("b.txt", "feat's\n");
    t.commit("b on feat");
    t.git(&["checkout", "-q", "main"]);
    t.write("b.txt", "mine\n");
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "main");
    assert!(!follows_checkout(&snap));
    assert_eq!(std::fs::read_to_string(t.path.join("b.txt")).unwrap(), "mine\n");
}

#[tokio::test]
async fn follows_moved_refs_on_reload_unless_the_reviewer_moved_head() {
    let t = branches();
    let remote = |t: &TestRepo| t.git(&["update-ref", "refs/remotes/origin/feat", "feat"]);
    remote(&t);
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...origin/feat"])).await.unwrap()).await.unwrap();
    // A push arrives: the remote branch moves past the detached HEAD.
    t.git(&["checkout", "-q", "feat"]);
    t.write("a.txt", "one\ntwo\nthree\n");
    t.commit("more");
    remote(&t);
    t.git(&["checkout", "-q", "--detach", "feat~1"]);
    let snap = s.reload().await.unwrap();
    assert_eq!(t.git(&["rev-parse", "HEAD"]), t.git(&["rev-parse", "feat"]));
    assert!(follows_checkout(&snap));
    // Back on main by hand: a later reload leaves it there.
    t.git(&["checkout", "-q", "main"]);
    t.git(&["update-ref", "refs/remotes/origin/feat", "feat~1"]);
    s.reload().await.unwrap();
    assert_eq!(head(&t), "main");
}

#[tokio::test]
async fn puts_the_checkout_back_on_close() {
    let t = branches();
    t.git(&["checkout", "-q", "-b", "other", "main"]);
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    s.enter(revspec(&["feat..main"])).await.unwrap();
    assert_eq!(head(&t), "main");
    // Back to where the run started, not to the review before last.
    s.close().await;
    assert_eq!(head(&t), "other");
    // Closed, a late request no longer moves it.
    s.enter(revspec(&["main...feat"])).await.unwrap();
    assert_eq!(head(&t), "other");
}

#[tokio::test]
async fn leaves_the_checkout_where_the_reviewer_left_it() {
    let t = branches();
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    // Uncommitted work would be carried onto main.
    t.write("a.txt", "fixing in place\n");
    s.close().await;
    assert_eq!(head(&t), "feat");
    assert_eq!(std::fs::read_to_string(t.path.join("a.txt")).unwrap(), "fixing in place\n");
    // Switched away by hand: theirs to keep.
    let t = branches();
    t.git(&["branch", "-q", "elsewhere", "main"]);
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    t.git(&["checkout", "-q", "elsewhere"]);
    s.close().await;
    assert_eq!(head(&t), "elsewhere");
}

#[tokio::test]
async fn puts_a_detached_head_back() {
    let t = branches();
    let main = t.git(&["rev-parse", "main"]);
    t.git(&["checkout", "-q", "--detach", "main"]);
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "feat");
    s.close().await;
    assert_eq!(head(&t), "HEAD");
    assert_eq!(t.git(&["rev-parse", "HEAD"]), main);
}

#[tokio::test]
async fn leaves_a_range_named_after_head_where_it_is() {
    let t = branches();
    let s = session(t.open().await, Github::tokenless(), true);
    // Switching to feat would make this feat..feat.
    let snap = s.start(s.resolve(revspec(&["HEAD..feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "main");
    assert_eq!(snap.changed.len(), 1, "still main..feat");
}

#[tokio::test]
async fn leaves_the_checkout_alone_when_the_worktree_is_the_old_side() {
    let t = branches();
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["worktree..feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "main");
    assert_eq!(snap.changed.len(), 1, "still the worktree against feat");
}
