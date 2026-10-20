mod common;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use common::TestRepo;
use diffle::watcher::{IgnoredFn, WatchTarget, Watcher};

const DEBOUNCE: Duration = Duration::from_millis(150);

fn repo() -> TestRepo {
    let t = TestRepo::new();
    t.write(".gitignore", "ignored.txt\nnode_modules/\n");
    t.write("a.txt", "a\n");
    t.commit("base");
    t.write("node_modules/dep/index.js", "x\n");
    t
}

async fn start(target: WatchTarget) -> (Watcher, Arc<AtomicUsize>) {
    let dirty = Arc::new(AtomicUsize::new(0));
    let count = dirty.clone();
    let watcher = Watcher::start(target, DEBOUNCE, move || {
        count.fetch_add(1, Ordering::SeqCst);
    })
    .await
    .unwrap();
    (watcher, dirty)
}

/// Waits until `dirty` exceeds `seen`, or fails after a generous deadline.
async fn changed_from(dirty: &AtomicUsize, seen: usize) -> usize {
    let deadline = Instant::now() + Duration::from_secs(10);
    while dirty.load(Ordering::SeqCst) <= seen {
        assert!(Instant::now() < deadline, "no dirty signal");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    dirty.load(Ordering::SeqCst)
}

/// Waits past the debounce and a few polls, so a signal that is coming has arrived.
async fn settle() {
    tokio::time::sleep(DEBOUNCE + Duration::from_millis(600)).await;
}

fn worktree(t: &TestRepo) -> WatchTarget {
    let ignored: IgnoredFn =
        Arc::new(|| Arc::new(HashSet::from(["ignored.txt".to_owned(), "node_modules/".to_owned()])));
    let git_dir = t.path.join(".git");
    WatchTarget::Worktree { root: t.path.clone(), common_dir: git_dir.clone(), git_dir, ignored }
}

#[tokio::test]
async fn a_worktree_edit_signals_once_and_an_ignored_one_not_at_all() {
    let t = repo();
    let (watcher, dirty) = start(worktree(&t)).await;
    settle().await;
    let base = dirty.load(Ordering::SeqCst);
    t.write("ignored.txt", "i\n");
    t.write("node_modules/dep/index.js", "y\n");
    settle().await;
    assert_eq!(dirty.load(Ordering::SeqCst), base, "ignored paths signalled");
    t.write("a.txt", "b\n");
    t.write("a.txt", "c\n");
    let after = changed_from(&dirty, base).await;
    settle().await;
    assert_eq!(dirty.load(Ordering::SeqCst), after, "a burst of writes yields one signal");
    // A new directory and a file inside it are seen, however the backend watches directories.
    t.write("src/deep/new.txt", "n\n");
    let after = changed_from(&dirty, after).await;
    settle().await;
    t.write("src/deep/new.txt", "m\n");
    changed_from(&dirty, after).await;
    watcher.close().await;
}

#[tokio::test]
async fn staging_moves_the_index_in_worktree_mode() {
    let t = repo();
    t.write("b.txt", "b\n");
    let (watcher, dirty) = start(worktree(&t)).await;
    settle().await;
    let base = dirty.load(Ordering::SeqCst);
    t.git(&["add", "b.txt"]);
    changed_from(&dirty, base).await;
    watcher.close().await;
}

#[tokio::test]
async fn refs_mode_signals_a_commit_but_not_a_worktree_edit() {
    let t = repo();
    let git_dir = t.path.join(".git");
    let (watcher, dirty) = start(WatchTarget::Refs { common_dir: git_dir.clone(), git_dir }).await;
    t.write("a.txt", "edited\n");
    settle().await;
    assert_eq!(dirty.load(Ordering::SeqCst), 0, "a worktree edit signalled in refs mode");
    t.git(&["commit", "-q", "-am", "next"]);
    let after = changed_from(&dirty, 0).await;
    // A second move within the same second is still seen.
    t.write("a.txt", "again\n");
    t.git(&["commit", "-q", "-am", "again"]);
    changed_from(&dirty, after).await;
    watcher.close().await;
}

#[tokio::test]
async fn close_stops_signalling() {
    let t = repo();
    let (watcher, dirty) = start(worktree(&t)).await;
    watcher.close().await;
    t.write("a.txt", "z\n");
    t.git(&["commit", "-q", "-am", "z"]);
    settle().await;
    assert_eq!(dirty.load(Ordering::SeqCst), 0);
}
