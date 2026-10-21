//! A pull request on a stand-in GitHub, for the pull request tests.
use std::path::{Path, PathBuf};

use diffle::git::GitRepo;
use serde_json::{Value, json};

use super::git_in;
use super::github::{FakeGithub, knows};

/// A bare "GitHub" holding refs/pull/7/head under a path ending in o/r, and a clone of it that has
/// never seen the pull request, whose origin reads as github.com/o/r.
pub struct Fixture {
    tmp: tempfile::TempDir,
    pub origin: PathBuf,
    pub local: PathBuf,
    pub head: String,
    pub merge_base: String,
}

/// A local path as git sees a url: Windows separators would be escapes inside a config value.
pub fn as_git_url(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

impl Fixture {
    pub fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let origin = root.join("o").join("r");
        std::fs::create_dir_all(&origin).unwrap();
        git_in(&origin, &["init", "-q", "-b", "main"]);
        std::fs::write(origin.join("a.txt"), "one\n").unwrap();
        git_in(&origin, &["add", "."]);
        git_in(&origin, &["commit", "-q", "-m", "base"]);
        let merge_base = git_in(&origin, &["rev-parse", "HEAD"]);
        git_in(&origin, &["checkout", "-q", "-b", "feat"]);
        std::fs::write(origin.join("a.txt"), "one\ntwo\n").unwrap();
        git_in(&origin, &["commit", "-q", "-am", "feat"]);
        let head = git_in(&origin, &["rev-parse", "HEAD"]);
        // GitHub publishes the pull request head here; the branch itself may live in a fork.
        git_in(&origin, &["update-ref", "refs/pull/7/head", &head]);
        git_in(&origin, &["checkout", "-q", "main"]);
        git_in(&origin, &["branch", "-q", "-D", "feat"]);
        let local = root.join("work");
        git_in(&root, &["clone", "-q", &as_git_url(&origin), &as_git_url(&local)]);
        let fixture = Self { tmp, origin, local, head, merge_base };
        fixture.point_remote_at_github(&fixture.local, "origin");
        fixture
    }

    pub fn root(&self) -> PathBuf {
        dunce::canonicalize(self.tmp.path()).unwrap()
    }

    /// Makes `remote` look like github.com/o/r while fetching from the bare repository.
    pub fn point_remote_at_github(&self, cwd: &Path, remote: &str) {
        git_in(cwd, &["remote", "set-url", remote, "https://github.com/o/r"]);
        git_in(cwd, &["config", &format!("url.{}.insteadOf", as_git_url(&self.origin)), "https://github.com/o/r"]);
    }

    /// What GitHub would say for pull request 7 of o/r, with `over` replacing fields.
    pub fn node(&self, over: Value) -> Value {
        let mut node = json!({
            "title": "Improve feature",
            "state": "OPEN",
            "isDraft": false,
            "baseRefOid": self.merge_base,
            "number": 7,
            "url": "https://github.com/o/r/pull/7",
            "baseRefName": "main",
            "headRefName": "feat",
            "headRefOid": "unused-here",
            "headRepository": { "name": "r", "owner": { "login": "o" } },
        });
        for (key, value) in over.as_object().unwrap() {
            node[key] = value.clone();
        }
        node
    }

    pub fn github(&self) -> FakeGithub {
        knows(Some(self.node(json!({}))))
    }

    pub async fn repo(&self) -> GitRepo {
        GitRepo::open(&self.local).await.unwrap()
    }
}
