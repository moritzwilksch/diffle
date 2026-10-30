//! Moving the checkout to what a review shows, so language servers index the new side.
use super::exec::split_z;
use super::{GitRepo, native};
use crate::error::GitError;

/// How a checkout changed one file on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Touched {
    Created,
    Changed,
    Deleted,
}

/// Where to move HEAD: onto a local branch, or detached at a commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckoutTarget {
    Branch(String),
    Detached(String),
}

impl GitRepo {
    /// Whether no tracked file differs from HEAD, staged or not. Untracked files do not count:
    /// a switch keeps them, and refuses when one would be overwritten.
    pub async fn is_clean(&self) -> Result<bool, GitError> {
        let out = self.exec(&["status", "--porcelain=v1", "-z", "--untracked-files=no"], Default::default()).await?;
        Ok(out.is_empty())
    }

    /// Where HEAD is: on a branch, or detached at a commit; none in an unborn repository's detached HEAD.
    pub async fn current_checkout(&self) -> Result<Option<CheckoutTarget>, GitError> {
        if let Ok(branch) = self.text(&["symbolic-ref", "--quiet", "--short", "HEAD"]).await {
            return Ok(Some(CheckoutTarget::Branch(branch.trim().to_owned())));
        }
        Ok(self.try_resolve("HEAD").await?.map(CheckoutTarget::Detached))
    }

    /// Whether HEAD already is `target`: on that branch, or at that commit, attached or not.
    pub async fn checked_out(&self, target: &CheckoutTarget) -> Result<bool, GitError> {
        Ok(match target {
            CheckoutTarget::Branch(name) => {
                let head = self.text(&["symbolic-ref", "--quiet", "--short", "HEAD"]).await.unwrap_or_default();
                head.trim() == name
            }
            CheckoutTarget::Detached(sha) => self.try_resolve("HEAD").await?.is_some_and(|head| &head == sha),
        })
    }

    /// Moves HEAD and the worktree to `target`. Git refuses, leaving everything as it was, when a
    /// change or an untracked file would be lost, or the branch is checked out in another worktree.
    pub async fn switch(&self, target: &CheckoutTarget) -> Result<(), GitError> {
        let args: &[&str] = match target {
            CheckoutTarget::Branch(name) => &["switch", "--quiet", "--no-guess", name],
            CheckoutTarget::Detached(sha) => &["switch", "--quiet", "--detach", sha],
        };
        self.exec(args, Default::default()).await?;
        Ok(())
    }

    /// Whether `branch` is checked out in another worktree of this repository, where git refuses to
    /// switch to it.
    pub async fn checked_out_elsewhere(&self, branch: &str) -> Result<bool, GitError> {
        let out = self.exec(&["worktree", "list", "--porcelain", "-z"], Default::default()).await?;
        let wanted = format!("branch refs/heads/{branch}");
        let mut here = false;
        for field in split_z(&out) {
            if let Some(path) = field.strip_prefix("worktree ") {
                here = native(path) == self.root;
            } else if field == wanted && !here {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The files that differ between two commits, as moving the checkout from `old` to `new` touches them.
    pub async fn touched_between(&self, old: &str, new: &str) -> Result<Vec<(String, Touched)>, GitError> {
        let args = ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", old, new, "--"];
        let fields = split_z(&self.exec(&args, Default::default()).await?);
        Ok(fields
            .as_chunks::<2>()
            .0
            .iter()
            .map(|[status, path]| {
                let touched = match status.as_str() {
                    "A" => Touched::Created,
                    "D" => Touched::Deleted,
                    _ => Touched::Changed,
                };
                (path.clone(), touched)
            })
            .collect())
    }
}
