//! Temporary real repositories for the integration tests.
#![allow(dead_code)]
pub mod github;
#[cfg(unix)]
pub mod lsp;
pub mod pr;
pub mod server;
use std::path::{Path, PathBuf};
use std::process::Command;

use diffle::git::GitRepo;

pub struct TestRepo {
    _dir: tempfile::TempDir,
    pub path: PathBuf,
}

impl TestRepo {
    /// An empty repository on `main`, with a fixed identity and no global config.
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // The canonical path as git prints it: macOS's /var is a link to /private/var, and
        // Windows gets the drive form rather than the verbatim `\\?\` one.
        let path = dunce::canonicalize(dir.path()).unwrap();
        let repo = Self { _dir: dir, path };
        repo.git(&["init", "-q", "-b", "main"]);
        // Git's detached background maintenance writes refs after a commit, a watcher signal no test expects.
        repo.git(&["config", "maintenance.auto", "false"]);
        repo.git(&["config", "gc.auto", "0"]);
        repo
    }

    pub fn git(&self, args: &[&str]) -> String {
        git_in(&self.path, args)
    }

    pub fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let file = self.path.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }

    pub fn rm(&self, path: &str) {
        let file = self.path.join(path);
        if file.is_dir() { std::fs::remove_dir_all(file).unwrap() } else { std::fs::remove_file(file).unwrap() }
    }

    pub fn commit(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
    }

    pub async fn open(&self) -> GitRepo {
        GitRepo::open(&self.path).await.unwrap()
    }
}

pub fn git_in(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", std::env::temp_dir().join("diffle-tests-no-global-gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

use std::sync::Arc;

use diffle::github::hosts::Github;
use diffle::mode::keys::range_comment_key;
use diffle::mode::resolve::resolve_range;
use diffle::mode::resolve::resolve_review;
use diffle::protocol::{EnterRequest, Review, Snapshot};
use diffle::snapshotter::Snapshotter;

pub fn revspec(args: &[&str]) -> EnterRequest {
    EnterRequest::Revspec { args: args.iter().map(|a| (*a).to_owned()).collect() }
}

pub async fn mode(repo: &GitRepo, req: EnterRequest) -> Review {
    resolve_review(&req, repo, &Github::tokenless()).await.unwrap()
}

/// Where the review's range keeps its comments, as the session derives it; none for a lone commit.
pub async fn range_key(repo: &GitRepo, review: &Review) -> Option<String> {
    let Review::Range { old, new, base, pr, .. } = review else { return None };
    let ends = resolve_range(repo, old, new, *base).await.unwrap();
    let instance = &Github::tokenless().instance;
    let key = range_comment_key(repo, instance, (old, new, *base), pr.as_ref(), (&ends.old_sha, &ends.new_sha));
    Some(key.await.unwrap())
}

/// A snapshotter for `req` at version 1 with three lines of context, and its first snapshot.
pub async fn snapshot(repo: &Arc<GitRepo>, req: EnterRequest) -> (Arc<Snapshotter>, Arc<Snapshot>) {
    let review = mode(repo, req).await;
    let key = range_key(repo, &review).await;
    let snapshotter = Snapshotter::new(repo.clone(), review, key, 1, 3, None);
    let snap = snapshotter.current().await.unwrap();
    (snapshotter, snap)
}

pub fn paths(snap: &Snapshot) -> Vec<&str> {
    snap.changed.iter().map(|f| f.path.as_str()).collect()
}

pub fn statuses(snap: &Snapshot) -> Vec<(&str, diffle::protocol::ChangeStatus)> {
    snap.changed.iter().map(|f| (f.path.as_str(), f.status)).collect()
}

use diffle::protocol::{FollowRefs, ServerMessage};
use diffle::session::{Broadcaster, Session, SessionOptions};

/// Every message a session broadcast, as JSON for easy comparison.
#[derive(Default)]
pub struct Recorder(std::sync::Mutex<Vec<serde_json::Value>>);

impl Broadcaster for Recorder {
    fn broadcast(&self, msg: ServerMessage) {
        self.0.lock().unwrap().push(serde_json::to_value(msg).unwrap());
    }
}

impl Recorder {
    pub fn messages(&self) -> Vec<serde_json::Value> {
        self.0.lock().unwrap().clone()
    }
}

pub fn session(
    repo: &Arc<GitRepo>,
    watch: bool,
    context: u32,
    follow_refs: FollowRefs,
) -> (Arc<Session>, Arc<Recorder>) {
    let hub = Arc::new(Recorder::default());
    let opts = SessionOptions { watch, github: Github::tokenless(), context, follow_refs };
    (Session::new(repo.clone(), hub.clone(), opts), hub)
}

/// Polls `check` until it holds, failing after thirty seconds: watchers poll and debounce, and a
/// loaded machine spawns git slowly.
pub async fn eventually(what: &str, mut check: impl AsyncFnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !check().await {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}
