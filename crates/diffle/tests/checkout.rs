//! Entering a branch or a pull request checks it out when the worktree is clean, so language
//! servers see the new side.
mod common;

use std::sync::Arc;

use common::pr::Fixture;
use common::{Recorder, TestRepo, revspec};
use diffle::git::{GitRepo, Touched};
use diffle::github::client::GithubClient;
use diffle::github::hosts::{Github, GithubInstance};
use diffle::protocol::{EnterRequest, FollowRefs, RangeView, comparison_label, follows_checkout};
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
async fn lists_what_moving_between_two_commits_touches() {
    let t = branches();
    t.git(&["checkout", "-q", "feat"]);
    t.write("new.txt", "x\n");
    t.write("dir/nested.txt", "y\n");
    t.commit("add");
    t.rm("new.txt");
    t.commit("remove");
    let repo = t.open().await;
    let touched = repo.touched_between("main", "feat~1").await.unwrap();
    let created = |p: &str| (p.to_owned(), Touched::Created);
    assert_eq!(touched, [("a.txt".to_owned(), Touched::Changed), created("dir/nested.txt"), created("new.txt")]);
    let back = repo.touched_between("feat~1", "feat").await.unwrap();
    assert_eq!(back, [("new.txt".to_owned(), Touched::Deleted)]);
}

#[tokio::test]
async fn keeps_a_range_named_after_head_on_where_the_reviewer_left_it() {
    let t = branches();
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["HEAD..feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "feat");
    assert_eq!(snap.changed.len(), 1, "still main..feat, not feat..feat");
    assert_eq!(comparison_label(&snap.review), "HEAD..feat");
    s.close().await;
    assert_eq!(head(&t), "main");
}

/// `branches`, with HEAD on feat and feat two commits ahead of main.
fn on_feat() -> (TestRepo, String) {
    let t = branches();
    t.git(&["checkout", "-q", "feat"]);
    t.write("a.txt", "one\ntwo\nthree\n");
    t.commit("more");
    let first = t.git(&["rev-parse", "feat~1"]);
    (t, first)
}

#[tokio::test]
async fn checks_out_a_focused_commit_and_the_range_again() {
    let (t, first) = on_feat();
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...HEAD"])).await.unwrap()).await.unwrap();
    let snap = s.show(RangeView::Commit { sha: first.clone() }).await.unwrap();
    assert_eq!((head(&t), t.git(&["rev-parse", "HEAD"])), ("HEAD".to_owned(), first));
    assert!(follows_checkout(&snap));
    assert_eq!(snap.commits.list.len(), 2, "HEAD still names feat: the range keeps both commits");
    let snap = s.show(RangeView::Whole).await.unwrap();
    assert_eq!(head(&t), "feat");
    assert!(follows_checkout(&snap));
}

#[tokio::test]
async fn follows_the_reviewer_rewriting_a_focused_commit() {
    let (t, first) = on_feat();
    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...HEAD"])).await.unwrap()).await.unwrap();
    s.show(RangeView::Commit { sha: first }).await.unwrap();
    // Amended in place: HEAD is the reviewer's again, and the range ends at it.
    t.write("a.txt", "one\n2\n");
    t.git(&["commit", "-q", "-a", "--amend", "-m", "feat, amended"]);
    let amended = t.git(&["rev-parse", "HEAD"]);
    let snap = s.reload().await.unwrap();
    assert_eq!(snap.commits.new_sha, amended);
    s.show(RangeView::Whole).await.unwrap();
    assert_eq!(t.git(&["rev-parse", "HEAD"]), amended, "nothing moves the reviewer's HEAD");
    s.close().await;
    assert_eq!(t.git(&["rev-parse", "HEAD"]), amended);
}

#[tokio::test]
async fn leaves_the_checkout_alone_when_the_worktree_is_the_old_side() {
    let t = branches();
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["worktree..feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "main");
    assert_eq!(snap.changed.len(), 1, "still the worktree against feat");
}

#[tokio::test]
async fn puts_the_checkout_back_past_a_submodule_the_switch_left_behind() {
    let sub = TestRepo::new();
    sub.write("lib.txt", "one\n");
    sub.commit("one");
    let first = sub.git(&["rev-parse", "HEAD"]);
    sub.write("lib.txt", "two\n");
    sub.commit("two");
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    let url = sub.path.to_str().unwrap();
    t.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", url, "sub"]);
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.git(&["-C", "sub", "checkout", "-q", &first]);
    t.write("a.txt", "one\ntwo\n");
    t.commit("feat, on the older submodule");
    t.git(&["checkout", "-q", "main"]);
    t.git(&["submodule", "update", "-q"]);

    let s = session(t.open().await, Github::tokenless(), true);
    s.start(s.resolve(revspec(&["main...feat"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "feat");
    // The switch kept the submodule on main's commit, which feat's recorded commit is not.
    assert!(!t.git(&["status", "--porcelain"]).is_empty());
    s.close().await;
    assert_eq!(head(&t), "main", "the submodule is no change of the reviewer's to keep it on feat");
}

#[tokio::test]
async fn keeps_a_previous_branch_naming_the_reviewers() {
    let t = branches();
    t.git(&["checkout", "-q", "-b", "old"]);
    t.write("b.txt", "old\n");
    t.commit("old");
    t.git(&["checkout", "-q", "main"]);
    let s = session(t.open().await, Github::tokenless(), true);
    let snap = s.start(s.resolve(revspec(&["feat..@{-1}"])).await.unwrap()).await.unwrap();
    assert_eq!(head(&t), "old");
    assert_eq!(comparison_label(&snap.review), "feat..@{-1}");
    // After the switch git's @{-1} is main, where feat..main changes nothing.
    assert_eq!(common::paths(&snap), ["a.txt", "b.txt"], "still feat..old");
    let snap = s.reload().await.unwrap();
    assert_eq!(common::paths(&snap), ["a.txt", "b.txt"]);
    s.close().await;
    assert_eq!(head(&t), "main");
}

#[tokio::test]
async fn logs_each_switch_in_heads_reflog_as_git_does() {
    let t = branches();
    let (main, feat) = (t.git(&["rev-parse", "main"]), t.git(&["rev-parse", "feat"]));
    let repo = t.open().await;
    repo.switch(&diffle::git::CheckoutTarget::Branch("feat".into())).await.unwrap();
    repo.switch(&diffle::git::CheckoutTarget::Detached(main.clone())).await.unwrap();
    let log = t.git(&["reflog", "-n", "2", "--format=%H %gs", "HEAD"]);
    assert_eq!(log, format!("{main} checkout: moving from feat to {main}\n{feat} checkout: moving from main to feat"));
    assert_eq!(t.git(&["rev-parse", "--symbolic-full-name", "@{-1}"]), "refs/heads/feat");
    assert_eq!(t.git(&["status", "--porcelain"]), "");
}

#[tokio::test]
async fn switches_files_modes_links_and_directories_as_git_checks_them_out() {
    let t = TestRepo::new();
    t.write(".gitattributes", "*.crlf text eol=crlf\n");
    t.write("keep.txt", "same\n");
    t.write("gone/deep/x.txt", "x\n");
    t.write("becomes", "a file, then a directory\n");
    t.write("text.crlf", "one\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.rm("gone");
    t.rm("becomes");
    t.write("becomes/inner.txt", "inside\n");
    t.write("text.crlf", "one\ntwo\n");
    t.write("tool.sh", "echo hi\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(t.path.join("tool.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("keep.txt", t.path.join("link")).unwrap();
    }
    t.commit("feat");
    t.git(&["checkout", "-q", "main"]);
    let repo = t.open().await;
    repo.switch(&diffle::git::CheckoutTarget::Branch("feat".into())).await.unwrap();
    assert_eq!(head(&t), "feat");
    assert_eq!(t.git(&["status", "--porcelain", "--untracked-files=all"]), "");
    assert!(!t.path.join("gone").exists(), "an emptied directory goes");
    // What git itself checks out for the same commit, byte for byte.
    let fresh = tempfile::tempdir().unwrap();
    common::git_in(fresh.path(), &["clone", "-q", "-b", "feat", &t.path.to_string_lossy(), "."]);
    for path in ["becomes/inner.txt", "text.crlf", "tool.sh", "keep.txt"] {
        assert_eq!(
            std::fs::read(t.path.join(path)).unwrap(),
            std::fs::read(fresh.path().join(path)).unwrap(),
            "{path}"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(std::fs::metadata(t.path.join("tool.sh")).unwrap().permissions().mode() & 0o111, 0);
        assert_eq!(std::fs::read_link(t.path.join("link")).unwrap(), std::path::Path::new("keep.txt"));
    }
    // And back: the directory turns into the file again.
    repo.switch(&diffle::git::CheckoutTarget::Branch("main".into())).await.unwrap();
    assert_eq!(t.git(&["status", "--porcelain", "--untracked-files=all"]), "");
    assert_eq!(std::fs::read_to_string(t.path.join("becomes")).unwrap(), "a file, then a directory\n");
    assert!(repo.is_clean().await.unwrap());
}

#[tokio::test]
async fn a_change_only_the_index_holds_is_not_clean() {
    let t = branches();
    let repo = t.open().await;
    // Added, then removed from disk: git status shows `AD`.
    t.write("new.txt", "staged\n");
    t.git(&["add", "new.txt"]);
    t.rm("new.txt");
    assert!(!repo.is_clean().await.unwrap());
    t.git(&["reset", "-q"]);
    // A staged edit whose worktree went back to HEAD's content: `M `, and a switch would lose it.
    t.write("a.txt", "staged\n");
    t.git(&["add", "a.txt"]);
    t.write("a.txt", "one\n");
    assert!(!repo.is_clean().await.unwrap());
    let refused = repo.switch(&diffle::git::CheckoutTarget::Branch("feat".into())).await.unwrap_err();
    assert_eq!(
        refused.to_string(),
        "Your local changes to the following files would be overwritten by checkout: a.txt"
    );
    assert_eq!(t.git(&["show", ":a.txt"]), "staged");
}

#[tokio::test]
async fn keeps_a_sparse_checkout_sparse_across_a_switch() {
    let t = TestRepo::new();
    t.write("top.txt", "top\n");
    t.write("inside/a.txt", "a\n");
    t.write("outside/b.txt", "b\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("inside/a.txt", "a2\n");
    t.write("outside/b.txt", "b2\n");
    t.write("outside/new.txt", "new\n");
    t.commit("feat");
    t.git(&["checkout", "-q", "main"]);
    t.git(&["sparse-checkout", "set", "--cone", "inside"]);
    // Something staged elsewhere stays staged, as git switch carries it.
    t.write("top.txt", "staged\n");
    t.git(&["add", "top.txt"]);
    let repo = t.open().await;
    repo.switch(&diffle::git::CheckoutTarget::Branch("feat".into())).await.unwrap();
    assert_eq!(t.git(&["status", "--porcelain", "--untracked-files=all"]), "M  top.txt");
    assert_eq!(std::fs::read_to_string(t.path.join("inside/a.txt")).unwrap(), "a2\n");
    assert!(!t.path.join("outside").exists(), "paths outside the cone stay off disk");
    assert_eq!(
        t.git(&["ls-files", "-t", "--", "inside", "outside"]),
        "H inside/a.txt\nS outside/b.txt\nS outside/new.txt"
    );
    assert_eq!(t.git(&["rev-parse", ":outside/b.txt"]), t.git(&["rev-parse", "feat:outside/b.txt"]));
}

#[tokio::test]
async fn a_link_checked_out_as_a_file_is_unchanged_without_symlinks() {
    let t = TestRepo::new();
    t.write("target.txt", "x\n");
    t.commit("base");
    // A symlink committed without making one, so the test runs where links cannot be made.
    t.write("blob", "target.txt");
    let target = t.git(&["hash-object", "-w", "blob"]);
    t.rm("blob");
    t.git(&["update-index", "--add", "--cacheinfo", &format!("120000,{target},link")]);
    t.git(&["commit", "-q", "-m", "link"]);
    t.git(&["config", "core.symlinks", "false"]);
    t.git(&["checkout", "--", "link"]);
    assert_eq!(std::fs::read_to_string(t.path.join("link")).unwrap(), "target.txt");
    assert_eq!(t.git(&["status", "--porcelain"]), "");
    let repo = t.open().await;
    assert!(repo.is_clean().await.unwrap());
    assert!(repo.numstat("HEAD", "worktree").await.unwrap().is_empty());
    // An edit to the file is an edit to the link, as git sees it, not a typechange.
    t.write("link", "elsewhere.txt");
    let files = repo.numstat("HEAD", "worktree").await.unwrap();
    assert_eq!(
        files.iter().map(|f| (f.path.as_str(), f.status)).collect::<Vec<_>>(),
        [("link", diffle::protocol::ChangeStatus::M)]
    );
}
