//! Temporary real repositories for the integration tests.
#![allow(dead_code)]
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
        // The canonical path: git prints it, and macOS's /var is a link to /private/var.
        let path = dir.path().canonicalize().unwrap();
        let repo = Self { _dir: dir, path };
        repo.git(&["init", "-q", "-b", "main"]);
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
        .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

use std::sync::Arc;

use diffle::github::hosts::GithubInstance;
use diffle::mode::resolve::resolve_review;
use diffle::protocol::{ModeRequest, ModeSpec, Snapshot};
use diffle::snapshotter::Snapshotter;

pub fn revspec(args: &[&str]) -> ModeRequest {
    ModeRequest::Revspec { args: args.iter().map(|a| (*a).to_owned()).collect() }
}

pub async fn mode(repo: &GitRepo, req: ModeRequest) -> ModeSpec {
    resolve_review(&req, repo, &GithubInstance::github_com()).await.unwrap()
}

/// A snapshotter for `req` at version 1 with three lines of context, and its first snapshot.
pub async fn snapshot(repo: &Arc<GitRepo>, req: ModeRequest) -> (Arc<Snapshotter>, Arc<Snapshot>) {
    let snapshotter = Snapshotter::new(repo.clone(), mode(repo, req).await, 1, 3, None);
    let snap = snapshotter.current().await.unwrap();
    (snapshotter, snap)
}

pub fn paths(snap: &Snapshot) -> Vec<&str> {
    snap.changed.iter().map(|f| f.path.as_str()).collect()
}

pub fn statuses(snap: &Snapshot) -> Vec<(&str, diffle::protocol::ChangeStatus)> {
    snap.changed.iter().map(|f| (f.path.as_str(), f.status)).collect()
}
