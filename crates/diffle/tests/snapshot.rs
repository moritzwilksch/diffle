mod common;

use std::sync::Arc;

use common::{TestRepo, mode, paths, revspec, snapshot, statuses};
use diffle::mode::resolve::range;
use diffle::protocol::{ChangeStatus::*, ComparisonBase, EnterRequest, Live, Review};

/// The same history as `git.rs`: main and feat diverge, feat has uncommitted work.
fn feature_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\ntwo\n");
    t.write("keep.txt", "k\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("a.txt", "one\ntwo\nthree\n");
    t.write("new.txt", "n\n");
    t.commit("feat 1");
    t.git(&["checkout", "-q", "main"]);
    t.write("keep.txt", "k2\n");
    t.commit("main moves on");
    t.git(&["checkout", "-q", "feat"]);
    t.write("a.txt", "one\ntwo\nthree\nfour\n");
    t.write("untracked.txt", "u\n");
    t.write(".gitignore", "ignored.txt\n");
    t.write("ignored.txt", "i\n");
    t
}

#[tokio::test]
async fn a_lone_revision_diffs_its_merge_base_with_head_against_head() {
    let t = feature_repo();
    let repo = Arc::new(t.open().await);
    let m = mode(&repo, revspec(&["main"])).await;
    assert_eq!(json(&m), json(&range("main", "HEAD", ComparisonBase::MergeBase)));
    let (_, snap) = snapshot(&repo, revspec(&["main"])).await;
    assert_eq!((snap.follows, snap.comment_key.as_str()), (Live::Refs, "range:refs/heads/main...refs/heads/feat"));
    assert_eq!(snap.old_sha, repo.merge_base("main", "feat").await.unwrap());
    assert_eq!(paths(&snap), ["a.txt", "new.txt"]);
    assert_eq!(snap.tree, ["a.txt", "keep.txt", "new.txt"]);
}

#[tokio::test]
async fn the_tree_belongs_to_the_selected_new_revision_not_the_index() {
    let t = feature_repo();
    let repo = Arc::new(t.open().await);
    let (_, snap) = snapshot(&repo, revspec(&["feat..main"])).await;
    assert_eq!(snap.tree, ["a.txt", "keep.txt"]);
    assert_eq!(statuses(&snap), [("a.txt", M), ("keep.txt", M), ("new.txt", D)]);
}

#[tokio::test]
async fn working_mode_is_live_on_the_worktree() {
    let t = feature_repo();
    let repo = Arc::new(t.open().await);
    let (_, snap) = snapshot(&repo, EnterRequest::Working).await;
    assert_eq!((snap.new_sha.as_str(), snap.follows), ("worktree", Live::Worktree));
    assert!(snap.tree.contains(&"untracked.txt".to_owned()));
    assert!(!snap.tree.contains(&"ignored.txt".to_owned()));
}

#[tokio::test]
async fn pinned_shas_are_static_and_symbolic_refs_live() {
    let t = feature_repo();
    let repo = Arc::new(t.open().await);
    let sha = repo.resolve("main").await.unwrap();
    let follows = async |args: &[&str]| snapshot(&repo, revspec(args)).await.1.follows;
    assert_eq!(follows(&[&format!("{sha}..{sha}")]).await, Live::None);
    assert_eq!(follows(&["main..feat"]).await, Live::Refs);
    assert_eq!(follows(&["main"]).await, Live::Refs);
    assert_eq!(follows(&["main..worktree"]).await, Live::Worktree);
}

#[tokio::test]
async fn reverses_the_worktree_on_the_old_side_in_every_patch_api() {
    let t = feature_repo();
    let repo = Arc::new(t.open().await);
    let (snapshotter, snap) = snapshot(&repo, revspec(&["worktree..HEAD"])).await;
    assert_eq!((snap.old_sha.as_str(), snap.follows), ("worktree", Live::Worktree));
    assert!(!snap.tree.contains(&"untracked.txt".to_owned()));
    let file = |path: &str| snap.changed.iter().find(|f| f.path == path).unwrap();
    assert_eq!((file("a.txt").status, file("a.txt").additions, file("a.txt").deletions), (M, 0, 1));
    assert_eq!((file("untracked.txt").status, file("untracked.txt").deletions), (D, 1));
    let single = snapshotter.patch("untracked.txt").await.unwrap().unwrap();
    for part in ["diff --git a/untracked.txt b/untracked.txt", "--- a/untracked.txt", "+++ /dev/null", "-u"] {
        assert!(single.contains(part), "{part} missing from {single}");
    }
    assert!(snapshotter.patch_all().await.unwrap().contains(&single));
    let batch = snapshotter.patch_many(&["a.txt".into(), "untracked.txt".into()]).await.unwrap();
    assert!(batch.contains(&single) && batch.contains("-four"), "{batch}");
}

#[tokio::test]
async fn an_identical_worktree_comparison_is_empty_but_lists_untracked_files() {
    let t = feature_repo();
    let repo = Arc::new(t.open().await);
    let (snapshotter, snap) = snapshot(&repo, revspec(&["worktree", "worktree"])).await;
    assert!(snap.changed.is_empty());
    assert!(snap.tree.contains(&"untracked.txt".to_owned()));
    assert_eq!(snapshotter.patch_all().await.unwrap(), "");
}

/// root, then `second` on main beside a `side` branch, merged with --no-ff.
fn merge_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "one\n");
    t.commit("root");
    t.git(&["checkout", "-q", "-b", "side"]);
    t.write("side.txt", "s\n");
    t.commit("side");
    t.git(&["checkout", "-q", "main"]);
    t.write("a.txt", "one\ntwo\n");
    t.commit("second\n\nwith a body");
    t.git(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    t
}

#[tokio::test]
async fn pins_a_single_commit_and_shows_it_against_its_parent_with_its_message() {
    let t = merge_repo();
    let repo = Arc::new(t.open().await);
    let sha = t.git(&["rev-parse", "HEAD~1"]);
    let m = mode(&repo, revspec(&["HEAD~1^!"])).await;
    assert_eq!(json(&m), json(&Review::Commit { sha: sha.clone() }));
    let (_, snap) = snapshot(&repo, revspec(&["HEAD~1^!"])).await;
    assert_eq!(
        (snap.new_sha.as_str(), snap.follows, snap.comment_key.clone()),
        (sha.as_str(), Live::None, format!("commit:{sha}"))
    );
    assert_eq!(snap.old_sha, t.git(&["rev-parse", "HEAD~2"]));
    assert_eq!(statuses(&snap), [("a.txt", M)]);
    let commit = snap.commit.clone().unwrap();
    assert_eq!(commit.short, t.git(&["rev-parse", "--short", &sha]));
    assert_eq!(commit.message, "second\n\nwith a body");
    assert_eq!(commit.parent, Some(t.git(&["rev-parse", "HEAD~2"])));
    assert_eq!(commit.child, Some(t.git(&["rev-parse", "HEAD"])));
}

#[tokio::test]
async fn shows_root_and_merge_commits_against_the_empty_tree_and_first_parent() {
    let t = merge_repo();
    let repo = Arc::new(t.open().await);
    let (_, root) = snapshot(&repo, revspec(&["HEAD~2^!"])).await;
    assert_eq!(root.old_sha, repo.empty_tree().await.unwrap());
    assert_eq!(statuses(&root), [("a.txt", A)]);
    let (_, merge) = snapshot(&repo, revspec(&["HEAD^!"])).await;
    assert_eq!(merge.old_sha, t.git(&["rev-parse", "HEAD^1"]));
    assert_eq!(statuses(&merge), [("side.txt", A)]);
    let (_, range) = snapshot(&repo, revspec(&["HEAD~1..HEAD"])).await;
    assert!(range.commit.is_none());
}

#[tokio::test]
async fn steps_along_heads_first_parent_line_and_stops_at_its_ends() {
    let t = merge_repo();
    let repo = t.open().await;
    let [root, second, merge, side] = ["HEAD~2", "HEAD~1", "HEAD", "side"].map(|rev| t.git(&["rev-parse", rev]));
    let n = |sha: &str| {
        let repo = &repo;
        let sha = sha.to_owned();
        async move { repo.commit_neighbours(&sha).await.unwrap() }
    };
    assert_eq!(n(&root).await, (None, Some(second.clone())));
    assert_eq!(n(&second).await, (Some(root.clone()), Some(merge.clone())));
    assert_eq!(n(&merge).await, (Some(second.clone()), None));
    // The side commit's only descendant is the merge, whose first parent is not the side commit.
    assert_eq!(n(&side).await, (Some(root), None));
}

#[tokio::test]
async fn lists_a_ranges_commits_oldest_first_the_newest_past_the_limit() {
    let t = merge_repo();
    let repo = Arc::new(t.open().await);
    let [root, second, merge, side] = ["HEAD~2", "HEAD~1", "HEAD", "side"].map(|rev| t.git(&["rev-parse", rev]));
    let (_, snap) = snapshot(&repo, revspec(&["HEAD~2..HEAD"])).await;
    let range = &snap.commits;
    assert_eq!(range.total, 3);
    let last = range.list.last().unwrap();
    assert_eq!(
        (last.sha.as_str(), last.message.as_str(), last.author.as_str(), last.email.as_str()),
        (merge.as_str(), "merge side", "t", "t@t")
    );
    let mut shas: Vec<&str> = range.list.iter().map(|c| c.sha.as_str()).collect();
    shas.sort();
    let mut expected = [second.as_str(), side.as_str(), merge.as_str()];
    expected.sort();
    assert_eq!(shas, expected);
    for c in &range.list {
        assert_eq!(c.date, t.git(&["log", "-1", "--format=%at", &c.sha]).parse::<i64>().unwrap() * 1000);
    }
    let newest = repo.range_commits(&format!("{root}..{merge}"), 1).await.unwrap();
    assert_eq!(newest.list.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(), [merge.as_str()]);
    // A single commit spans only itself, a merge included; the worktree stands for HEAD.
    let (_, one) = snapshot(&repo, revspec(&["HEAD^!"])).await;
    assert_eq!((one.commits.total, one.commits.list[0].sha.as_str()), (1, merge.as_str()));
    let (_, body) = snapshot(&repo, revspec(&["HEAD~1^!"])).await;
    assert_eq!(body.commits.list[0].message, "second\n\nwith a body");
    let (_, worktree) = snapshot(&repo, revspec(&["HEAD~1..worktree"])).await;
    assert_eq!((worktree.commits.total, worktree.commits.list.last().unwrap().sha.as_str()), (2, merge.as_str()));
    let (_, none) = snapshot(&repo, revspec(&["HEAD..worktree"])).await;
    assert!(none.commits.list.is_empty() && none.commits.total == 0);
    assert_eq!((none.commits.old_sha.as_str(), none.commits.new_sha.as_str()), (merge.as_str(), "worktree"));
}

#[tokio::test]
async fn reports_an_unknown_commit_as_a_revspec_error() {
    let t = merge_repo();
    let repo = t.open().await;
    let req = revspec(&["nope^!"]);
    let err = diffle::mode::resolve::resolve_review(&req, &repo, &diffle::github::hosts::Github::tokenless())
        .await
        .unwrap_err();
    assert!(matches!(err, diffle::error::Error::Revspec(_)));
    assert_eq!(err.to_string(), "unknown revision: nope");
}

#[tokio::test]
async fn working_mode_on_an_unborn_branch_diffs_against_the_empty_tree() {
    let t = TestRepo::new();
    t.write("staged.txt", "s1\ns2\n");
    t.git(&["add", "staged.txt"]);
    t.write("loose.txt", "l\n");
    let repo = Arc::new(t.open().await);
    let (snapshotter, snap) = snapshot(&repo, EnterRequest::Working).await;
    assert_eq!(snap.old_sha, repo.empty_tree().await.unwrap());
    assert_eq!(snap.head_sha, "");
    let counts: Vec<_> = snap.changed.iter().map(|f| (f.path.as_str(), f.status, f.additions)).collect();
    assert_eq!(counts, [("loose.txt", A, 1), ("staged.txt", A, 2)]);
    assert_eq!(snap.tree, ["loose.txt", "staged.txt"]);
    assert!(snapshotter.patch("staged.txt").await.unwrap().unwrap().contains("+s2\n"));
    assert!(snapshotter.patch_all().await.unwrap().contains("+l\n"));
    let req = revspec(&["HEAD"]);
    let err = diffle::mode::resolve::resolve_review(&req, &repo, &diffle::github::hosts::Github::tokenless())
        .await
        .unwrap_err();
    assert_eq!(err.to_string(), "unknown revision: HEAD");
}

fn json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}
