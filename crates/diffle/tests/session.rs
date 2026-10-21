mod common;

use std::sync::{Arc, Mutex};

use common::{TestRepo, eventually, revspec, session};
use diffle::comments::CommentStore;
use diffle::error::Error;
use diffle::protocol::{
    CommentAnchor, EnterRequest, FollowRefs, Live, RangeView, Side, Snapshot, ThreadQuery, comparison_label, range_of,
    with_view,
};
use diffle::session::{ReadablePaths, side_path};

/// main has old.txt, same.txt and a symlink out of the repository; feat renames and edits old.txt.
/// An ignored secret sits in the worktree.
fn rename_repo() -> (TestRepo, tempfile::TempDir) {
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "host secret\n").unwrap();
    let t = TestRepo::new();
    t.write("old.txt", "alpha\nbeta\ngamma\n");
    t.write("same.txt", "same\n");
    t.write(".gitignore", "*.env\n");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), t.path.join("link.txt")).unwrap();
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.git(&["mv", "old.txt", "new.txt"]);
    t.write("new.txt", "alpha\nbeta\ngamma\ndelta\n");
    t.git(&["commit", "-q", "-am", "rename + edit"]);
    t.write("secret.env", "TOKEN=1\n");
    (t, outside)
}

fn line(path: &str, side: Side, line: i64, quoted: &str) -> CommentAnchor {
    CommentAnchor::Line { path: path.into(), side, start_line: line, end_line: line, quoted: quoted.into() }
}

async fn stale(comments: &CommentStore, ids: &[&str]) -> Vec<bool> {
    let mut out = Vec::new();
    for id in ids {
        out.push(comments.get(id).await.unwrap().unwrap().stale);
    }
    out
}

fn text(buf: Option<Vec<u8>>) -> Option<String> {
    buf.map(|b| String::from_utf8(b).unwrap())
}

#[test]
fn side_path_maps_renames_and_refuses_paths_outside_the_snapshot() {
    let snap: Snapshot = serde_json::from_value(serde_json::json!({
        "root": "/r", "version": 1, "oldSha": "a", "newSha": "b", "headSha": "b", "context": 3,
        "review": { "kind": "range", "old": "a", "new": "b", "base": "direct", "view": { "kind": "whole" } },
        "follows": "none", "commentKey": "k",
        "changed": [
            { "path": "new.txt", "oldPath": "old.txt", "status": "R", "additions": 0, "deletions": 0, "binary": false, "blob": "", "oldBlob": "", "generated": false },
            { "path": "gone.txt", "status": "D", "additions": 0, "deletions": 0, "binary": false, "blob": "", "oldBlob": "", "generated": false },
            { "path": "added.txt", "status": "A", "additions": 0, "deletions": 0, "binary": false, "blob": "", "oldBlob": "", "generated": false },
        ],
        "tree": ["new.txt", "same.txt", "added.txt"],
        "commit": null, "commits": { "list": [], "total": 0, "oldSha": "a", "newSha": "b" }, "iterations": [],
    }))
    .unwrap();
    let r = ReadablePaths::of(&snap);
    assert_eq!(side_path(&r, "new.txt", Side::Old), Some("old.txt"));
    assert_eq!(side_path(&r, "new.txt", Side::New), Some("new.txt"));
    assert_eq!(side_path(&r, "old.txt", Side::Old), Some("old.txt"));
    assert_eq!(side_path(&r, "gone.txt", Side::Old), Some("gone.txt"));
    assert_eq!(side_path(&r, "gone.txt", Side::New), None);
    assert_eq!(side_path(&r, "same.txt", Side::Old), Some("same.txt"));
    for p in [".git/config", "secret.env", "../etc/passwd", "nope.txt"] {
        assert_eq!((side_path(&r, p, Side::New), side_path(&r, p, Side::Old)), (None, None), "{p}");
    }
}

#[tokio::test]
async fn reads_both_sides_of_a_rename_by_its_new_path_and_relocates_comments_on_it() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let snap = s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let tree: Vec<&str> = snap.tree.iter().map(String::as_str).collect();
    assert_eq!(
        tree,
        if cfg!(unix) {
            vec![".gitignore", "link.txt", "new.txt", "same.txt"]
        } else {
            vec![".gitignore", "new.txt", "same.txt"]
        }
    );
    assert_eq!(text(s.read_side(&snap, "new.txt", Side::Old).await.unwrap()).unwrap(), "alpha\nbeta\ngamma\n");
    assert_eq!(text(s.read_side(&snap, "new.txt", Side::New).await.unwrap()).unwrap(), "alpha\nbeta\ngamma\ndelta\n");
    assert!(s.read_side(&snap, "old.txt", Side::New).await.unwrap().is_none());
    let comments = s.comments().unwrap();
    let c = comments.add_thread(line("new.txt", Side::Old, 2, "beta"), "old-side note".into()).await.unwrap();
    s.refresh().await;
    assert_eq!(stale(&comments, &[&c.id]).await, [false]);
    s.close().await;
}

#[tokio::test]
async fn flags_threads_stale_whose_lines_left_the_diff_on_start_and_on_context_change() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 0, FollowRefs::Off);
    s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let comments = s.comments().unwrap();
    // Context 0 shows only `delta`; `alpha` exists on both sides but is outside every hunk.
    let outside = comments.add_thread(line("new.txt", Side::New, 1, "alpha"), "context line".into()).await.unwrap();
    let inside = comments.add_thread(line("new.txt", Side::New, 4, "delta"), "added line".into()).await.unwrap();
    // `same.txt` is not in the diff: nothing displays an old-side thread on it, the file view shows a new-side one.
    let unchanged_old = comments.add_thread(line("same.txt", Side::Old, 1, "same"), "x".into()).await.unwrap();
    let unchanged_new = comments.add_thread(line("same.txt", Side::New, 1, "same"), "y".into()).await.unwrap();
    let ids = [&*outside.id, &*inside.id, &*unchanged_old.id, &*unchanged_new.id];
    s.refresh().await;
    assert_eq!(stale(&comments, &ids).await, [true, false, true, false]);
    assert_eq!(comments.get(&outside.id).await.unwrap().unwrap().stale_from_line, Some(1));
    // Three lines of context bring `alpha` back into the hunk.
    s.set_context(3).await.unwrap();
    assert_eq!(stale(&comments, &ids).await, [false, false, true, false]);
    s.set_context(0).await.unwrap();
    assert_eq!(stale(&comments, &ids).await, [true, false, true, false]);
    s.close().await;
    // A fresh session relocates against the snapshot before serving anything.
    let (again, _) = session(&repo, false, 3, FollowRefs::Off);
    again.start(again.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    assert_eq!(stale(&again.comments().unwrap(), &[&outside.id]).await, [false]);
    again.close().await;
}

#[tokio::test]
async fn notifies_snapshot_listeners_on_every_snapshot_in_version_order() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 0, FollowRefs::Off);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    s.on_snapshot(move |snap| record.lock().unwrap().push(snap.version));
    let first = s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    s.refresh().await;
    s.set_context(3).await.unwrap();
    s.enter(EnterRequest::Working).await.unwrap();
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 4);
    assert_eq!(seen[0], first.version);
    assert!(seen.is_sorted(), "{seen:?}");
    s.close().await;
}

#[tokio::test]
async fn keeps_versions_monotonic_and_the_context_agreed_when_transitions_race() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    s.on_snapshot(move |snap| record.lock().unwrap().push(snap.version));
    s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let (switched, context, ()) = tokio::join!(s.enter(EnterRequest::Working), s.set_context(5), s.refresh());
    switched.unwrap();
    context.unwrap();
    let seen = seen.lock().unwrap().clone();
    assert!(seen.windows(2).all(|w| w[0] < w[1]), "{seen:?}");
    assert_eq!(json(&s.review().unwrap())["new"], "worktree");
    let current = s.snapshotter().unwrap().current().await.unwrap();
    assert_eq!((s.context(), current.context, Some(&current.version)), (5, 5, seen.last()));
    s.close().await;
}

#[tokio::test]
async fn coalesces_refreshes_so_at_most_one_waits_behind_the_running_one() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let published = Arc::new(Mutex::new(0));
    let count = published.clone();
    s.on_snapshot(move |_| *count.lock().unwrap() += 1);
    s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let burst = [s.refresh(), s.refresh(), s.refresh(), s.refresh()];
    futures::future::join_all(burst).await;
    // The first may already run; the rest share the one queued behind it.
    let recomputes = *published.lock().unwrap() - 1;
    assert!((1..=2).contains(&recomputes), "{recomputes} recomputes");
    s.close().await;
}

#[tokio::test]
async fn focuses_one_listed_commit_of_a_range_keeps_listing_the_range_and_returns_to_it() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let range = s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let commit = range.commits.list[0].clone();
    let focused = s.show(RangeView::Commit { sha: commit.short.clone() }).await.unwrap();
    let view = RangeView::Commit { sha: commit.sha.clone() };
    assert_eq!(json(&focused.review), json(&with_view(&range.review, view.clone()).unwrap()));
    assert_eq!((focused.new_sha.as_str(), focused.follows), (commit.sha.as_str(), Live::Refs));
    assert_eq!(focused.comment_key, format!("commit:{}", commit.sha));
    assert_eq!(json(&focused.commits), json(&range.commits));
    assert_eq!(focused.commit.as_ref().unwrap().sha, commit.sha);
    // Stepping from one focused commit to another keeps the range, not the commit, as the outer comparison.
    let again = s.show(RangeView::Commit { sha: commit.sha.clone() }).await.unwrap();
    assert_eq!(json(&range_of(&again.review)), json(&range_of(&range.review)));
    let unknown = s.show(RangeView::Commit { sha: "f".repeat(40) }).await.unwrap_err();
    assert!(matches!(unknown, Error::Revspec(_)));
    assert_eq!(json(&s.show(RangeView::Whole).await.unwrap().review), json(&range.review));
    s.enter(revspec(&["feat^!"])).await.unwrap();
    assert!(matches!(s.show(RangeView::Whole).await, Err(Error::Revspec(_))));
    s.close().await;
}

#[tokio::test]
async fn focuses_the_uncommitted_changes_of_a_range_that_ends_at_the_worktree() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let working = s.start(s.resolve(EnterRequest::Working).await.unwrap()).await.unwrap();
    let range = s.enter(revspec(&["main..worktree"])).await.unwrap();
    let focused = s.show(RangeView::Uncommitted).await.unwrap();
    assert_eq!(json(&focused.review), json(&with_view(&range.review, RangeView::Uncommitted).unwrap()));
    let sides = |snap: &Snapshot| (snap.old_sha.clone(), snap.new_sha.clone(), snap.follows, snap.comment_key.clone());
    assert_eq!(sides(&focused), sides(&working));
    assert_eq!(json(&focused.changed), json(&working.changed));
    assert_eq!(json(&focused.commits.list), json(&range.commits.list));
    assert_eq!(comparison_label(&focused.review), "main..worktree @ worktree");
    s.enter(revspec(&["main..feat"])).await.unwrap();
    let refused = s.show(RangeView::Uncommitted).await;
    assert!(matches!(refused, Err(Error::Revspec(_))));
    s.close().await;
}

#[tokio::test]
async fn quotes_a_range_from_the_snapshot_for_imports_and_refuses_ranges_it_cannot_read() {
    use diffle::comments::AnchorSource;
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let source = s.anchor_source().unwrap();
    assert_eq!(source.quote("new.txt", Side::New, 2, 4).await.unwrap().as_deref(), Some("beta\ngamma\ndelta"));
    assert_eq!(source.quote("new.txt", Side::Old, 1, 1).await.unwrap().as_deref(), Some("alpha"));
    assert_eq!(source.quote("new.txt", Side::New, 4, 5).await.unwrap(), None);
    assert_eq!(source.quote("secret.env", Side::New, 1, 1).await.unwrap(), None);
    // File threads go on the review's files: a changed file by its new path, or any tree path.
    assert!(source.has_file("new.txt").await.unwrap() && source.has_file("same.txt").await.unwrap());
    for p in ["old.txt", "secret.env", ".git/config", "../etc/passwd"] {
        assert!(!source.has_file(p).await.unwrap(), "{p}");
    }
    s.close().await;
}

#[tokio::test]
async fn keeps_a_file_thread_fresh_while_its_file_is_in_the_review() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let comments = s.comments().unwrap();
    let file = |path: &str| CommentAnchor::File { path: path.into() };
    let renamed = comments.add_thread(file("new.txt"), "split this".into()).await.unwrap();
    let unchanged = comments.add_thread(file("same.txt"), "fine".into()).await.unwrap();
    let old_name = comments.add_thread(file("old.txt"), "gone".into()).await.unwrap();
    s.refresh().await;
    assert_eq!(stale(&comments, &[&renamed.id, &unchanged.id, &old_name.id]).await, [false, false, true]);
    // A file thread never has a line to remember.
    assert_eq!(comments.get(&old_name.id).await.unwrap().unwrap().stale_from_line, None);
    assert_eq!(comments.threads(&ThreadQuery::default()).await.unwrap().len(), 3);
    s.close().await;
}

#[tokio::test]
async fn refuses_an_absolute_path_and_returns_a_symlink_as_its_target_string() {
    let (t, outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let snap = s.start(s.resolve(EnterRequest::Working).await.unwrap()).await.unwrap();
    let secret = outside.path().join("secret.txt").to_string_lossy().into_owned();
    assert!(s.read_side(&snap, &secret, Side::New).await.unwrap().is_none());
    if cfg!(unix) {
        let link = text(s.read_side(&snap, "link.txt", Side::New).await.unwrap()).unwrap();
        assert_eq!(link, secret);
    }
    s.close().await;
}

#[tokio::test]
async fn maps_reverse_rename_anchors_into_the_worktree_and_keeps_the_new_side_allowlist() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, false, 3, FollowRefs::Off);
    let snap = s.start(s.resolve(revspec(&["worktree..main"])).await.unwrap()).await.unwrap();
    let renamed = snap.changed.iter().find(|f| f.path == "old.txt").unwrap();
    assert_eq!(renamed.old_path.as_deref(), Some("new.txt"));
    assert_eq!(text(s.read_side(&snap, "old.txt", Side::Old).await.unwrap()).unwrap(), "alpha\nbeta\ngamma\ndelta\n");
    assert_eq!(text(s.read_side(&snap, "old.txt", Side::New).await.unwrap()).unwrap(), "alpha\nbeta\ngamma\n");
    assert!(s.read_side(&snap, "secret.env", Side::Old).await.unwrap().is_none());
    assert!(s.read_side(&snap, "new.txt", Side::New).await.unwrap().is_none());
    s.close().await;
}

#[tokio::test]
async fn serializes_concurrent_mode_switches_so_the_last_request_wins() {
    let (t, _outside) = rename_repo();
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, true, 3, FollowRefs::Off);
    s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let (a, b) = tokio::join!(s.enter(EnterRequest::Working), s.enter(revspec(&["main"])));
    assert!(b.unwrap().version > a.unwrap().version);
    let review = json(&s.review().unwrap());
    assert_eq!((review["old"].as_str(), review["new"].as_str()), (Some("main"), Some("HEAD")));
    let current = s.snapshotter().unwrap().current().await.unwrap();
    assert_eq!(s.comments().unwrap().key(), current.comment_key);
    s.close().await;
}

fn json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

/// a.txt on main; feat adds a commit. The review runs from main, so the compared branch is not checked out.
fn refs_repo() -> TestRepo {
    let t = TestRepo::new();
    t.write("a.txt", "a\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("a.txt", "a\nb\n");
    t.git(&["commit", "-q", "-am", "one"]);
    t.git(&["checkout", "-q", "main"]);
    t
}

/// Commits on feat without checking it out, as a push would land.
fn push(t: &TestRepo, file: &str, content: &str, message: &str) -> String {
    t.git(&["checkout", "-q", "feat"]);
    t.write(file, content);
    t.git(&["commit", "-q", "-am", message]);
    t.git(&["checkout", "-q", "main"]);
    t.git(&["rev-parse", "feat"])
}

#[tokio::test]
async fn announces_moved_refs_instead_of_recomputing_until_asked_to_reload() {
    let t = refs_repo();
    let repo = Arc::new(t.open().await);
    let (s, hub) = session(&repo, true, 3, FollowRefs::Off);
    let published = Arc::new(Mutex::new(0));
    let count = published.clone();
    s.on_snapshot(move |_| *count.lock().unwrap() += 1);
    let first = s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    let before = hub.messages().len();
    assert_eq!((first.commits.total, first.commits.old_sha.clone()), (1, t.git(&["rev-parse", "main"])));
    assert!(s.moved().unwrap().is_none());
    assert!(!s.follows().unwrap());

    // A push to the compared branch: the snapshot stands, the clients hear where the ref went.
    let two = push(&t, "a.txt", "a\nb\nc\n", "two");
    eventually("the moved notice", async || s.moved().unwrap().is_some()).await;
    let moved = s.moved().unwrap().unwrap();
    assert_eq!(
        (moved.version, moved.old_sha.as_str(), moved.new_sha.as_str()),
        (first.version, first.old_sha.as_str(), two.as_str())
    );
    let messages = || hub.messages()[before..].to_vec();
    assert_eq!(messages(), [serde_json::json!({ "type": "moved", "moved": json(&moved) })]);
    assert_eq!(*published.lock().unwrap(), 1);
    assert!(Arc::ptr_eq(&s.snapshotter().unwrap().current().await.unwrap(), &first));

    // Back where the snapshot has it: the notice is withdrawn.
    t.git(&["update-ref", "refs/heads/feat", &first.new_sha]);
    eventually("the notice withdrawn", async || s.moved().unwrap().is_none()).await;
    assert_eq!(messages().last(), Some(&serde_json::json!({ "type": "moved", "moved": null })));

    t.git(&["update-ref", "refs/heads/feat", &two]);
    eventually("the moved notice again", async || s.moved().unwrap().is_some()).await;
    let reloaded = s.reload().await.unwrap();
    assert!(reloaded.version > first.version);
    assert_eq!(reloaded.new_sha, two);
    let messages_: Vec<_> = reloaded.commits.list.iter().map(|c| c.message.trim().to_owned()).collect();
    assert_eq!(messages_, ["one", "two"]);
    assert!(s.moved().unwrap().is_none());
    assert_eq!(messages().last(), Some(&serde_json::json!({ "type": "snapshot", "version": reloaded.version })));
    assert_eq!(*published.lock().unwrap(), 2);
    s.close().await;
}

#[tokio::test]
async fn refreshes_the_worktree_snapshot_when_only_the_index_or_head_changed() {
    let t = TestRepo::new();
    t.write(".gitignore", "*.env\n");
    t.write("secret.env", "TOKEN=1\n");
    t.git(&["add", ".gitignore"]);
    t.git(&["commit", "-q", "-m", "base"]);
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, true, 3, FollowRefs::Off);
    let first = s.start(s.resolve(EnterRequest::Working).await.unwrap()).await.unwrap();
    assert!(first.changed.is_empty());
    assert_eq!(first.tree, [".gitignore"]);
    let current = async || s.snapshotter().unwrap().current().await.unwrap();

    // The file never changed on disk; only the index did.
    t.git(&["add", "-f", "secret.env"]);
    eventually("the staged file", async || current().await.changed.iter().any(|f| f.path == "secret.env")).await;
    let staged = current().await;
    assert!(staged.version > first.version);
    assert_eq!(staged.tree, [".gitignore", "secret.env"]);

    // HEAD moves without any worktree write.
    t.git(&["commit", "-q", "-m", "force-added"]);
    eventually("the commit", async || current().await.head_sha != staged.head_sha).await;
    assert!(current().await.changed.is_empty());

    // Tracked now, the file is no longer ignored: an edit to it refreshes the review.
    t.write("secret.env", "TOKEN=2\n");
    eventually("the tracked edit", async || current().await.changed.iter().any(|f| f.path == "secret.env")).await;
    s.close().await;
}

#[tokio::test]
async fn follows_moved_refs_live_when_configured_recording_each_state_as_an_iteration() {
    let t = TestRepo::new();
    t.write("a.txt", "a\n");
    t.commit("base");
    t.git(&["checkout", "-q", "-b", "feat"]);
    t.write("a.txt", "a\nb\n");
    t.git(&["commit", "-q", "-am", "one"]);
    let repo = Arc::new(t.open().await);
    let (s, _) = session(&repo, true, 3, FollowRefs::On);
    let published: Arc<Mutex<Vec<Arc<Snapshot>>>> = Arc::default();
    let record = published.clone();
    s.on_snapshot(move |snap| record.lock().unwrap().push(snap.clone()));
    let first = s.start(s.resolve(revspec(&["main..feat"])).await.unwrap()).await.unwrap();
    assert!(s.follows().unwrap());
    assert_eq!(first.iterations.len(), 1);
    // One commit can signal more than once; what counts is what the latest snapshot shows.
    let latest = || published.lock().unwrap().last().unwrap().clone();
    t.write("a.txt", "a\nb\nc\n");
    t.git(&["commit", "-q", "-am", "two"]);
    let two = t.git(&["rev-parse", "feat"]);
    eventually("the followed commit", async || latest().new_sha == two).await;
    assert_eq!(latest().iterations.iter().map(|it| it.n).collect::<Vec<_>>(), [1, 2]);
    assert!(s.moved().unwrap().is_none());

    // Turned off at runtime: the next move is announced instead.
    s.set_follow_refs(FollowRefs::Off);
    assert!(!s.follows().unwrap());
    // A no-op behind every queued job: a refresh signalled while following was on has finished.
    s.set_context(3).await.unwrap();
    t.write("a.txt", "a\nb\nc\nd\n");
    t.git(&["commit", "-q", "-am", "three"]);
    let three = t.git(&["rev-parse", "feat"]);
    eventually("the moved notice", async || s.moved().unwrap().is_some_and(|m| m.new_sha == three)).await;
    // A late signal may still refresh the snapshot it has; it never takes up the moved refs.
    assert!(published.lock().unwrap().iter().all(|p| p.new_sha != three));

    // auto: a comparison naming a branch keeps waiting for Reload, one between expressions follows.
    s.set_follow_refs(FollowRefs::Auto);
    assert!(!s.follows().unwrap());
    t.git(&["checkout", "-q", "--detach"]);
    s.enter(revspec(&["HEAD~1..HEAD"])).await.unwrap();
    assert!(s.follows().unwrap());
    t.write("a.txt", "a\nb\nc\nd\ne\n");
    t.git(&["commit", "-q", "-am", "four"]);
    let four = t.git(&["rev-parse", "HEAD"]);
    eventually("the detached commit", async || latest().new_sha == four).await;
    s.close().await;
}
