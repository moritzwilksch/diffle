//! All Git access, in-process through gix: no git executable is spawned.
mod commits;
mod diff;
mod files;
mod grep;
mod index;
mod refs;
mod remote;
mod walk;

use std::path::{Path, PathBuf};

pub use diff::is_binary;
pub use grep::{GrepMatch, GrepOptions, GrepResult};
pub use refs::{Remote, Upstream};

use crate::error::{GitError, Result};

/// Objects a thread-local handle keeps decoded, so walks and repeated lookups skip re-inflating.
const OBJECT_CACHE: usize = 16 * 1024 * 1024;

/// Git's `core.bigFileThreshold` default: a file this large is diffed as binary without reading
/// it, which also bounds what sizing an untracked file loads.
pub const BIG_FILE_THRESHOLD: u64 = 512 * 1024 * 1024;

/// The uncommitted tree, accepted on either side of a comparison.
pub const WORKTREE: &str = "worktree";

pub struct GitRepo {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    /// Shared dir for worktrees (refs, packed-refs). Equals `git_dir` for the main worktree.
    pub common_dir: PathBuf,
    /// Where this run fetches pull requests; unique, so two servers never share refs.
    pub review_refs: String,
    repo: gix::ThreadSafeRepository,
}

impl GitRepo {
    pub async fn open(dir: &Path) -> Result<Self> {
        let dir = dir.to_owned();
        let opened = tokio::task::spawn_blocking(move || {
            let not_repo = || GitError {
                code: Some(128),
                ..GitError::refused(format!("not a git repository: {}", dir.display()), &[])
            };
            let repo = gix::ThreadSafeRepository::discover_with_environment_overrides(&dir).map_err(|_| not_repo())?;
            let local = repo.to_thread_local();
            // Paths as git prints them: absolute, links resolved, `.`/`..` folded.
            let canonical = |p: &Path| dunce::canonicalize(p).map(|p| native_path(&p)).map_err(|_| not_repo());
            let root = canonical(local.workdir().ok_or_else(not_repo)?)?;
            let (git_dir, common_dir) = (canonical(local.git_dir())?, canonical(local.common_dir())?);
            Ok::<_, GitError>((repo, root, git_dir, common_dir))
        })
        .await
        .map_err(|e| GitError::refused(format!("opening the repository failed: {e}"), &[]))?;
        let (repo, root, git_dir, common_dir) = opened?;
        Ok(Self { review_refs: format!("refs/diffle/{}", uuid::Uuid::new_v4()), root, git_dir, common_dir, repo })
    }

    /// Runs `f` on a thread-local gix handle off the async runtime, as gix blocks. `op` names the
    /// failure in the error.
    async fn gix<T, F>(&self, op: &str, f: F) -> Result<T, GitError>
    where
        T: Send + 'static,
        F: FnOnce(&gix::Repository) -> anyhow::Result<T> + Send + 'static,
    {
        let repo = self.repo.clone();
        let failed = |e: &dyn std::fmt::Display| GitError::refused(format!("{op} failed: {e:#}"), &[]);
        tokio::task::spawn_blocking(move || {
            let mut repo = repo.to_thread_local();
            repo.object_cache_size_if_unset(OBJECT_CACHE);
            f(&repo)
        })
        .await
        .map_err(|e| failed(&e))?
        .map_err(|e| failed(&e))
    }
}

/// Separators as the platform writes them, and `.`/`..` folded, so paths compare equal to joined ones.
fn native_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `path` under `root`, or none when it would leave the repository.
fn inside(root: &Path, path: &str) -> Option<PathBuf> {
    let joined = native_path(&root.join(path));
    joined.starts_with(root).then_some(joined)
}
