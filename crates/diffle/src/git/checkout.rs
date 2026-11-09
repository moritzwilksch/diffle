//! Where the checkout is and what moving it would touch; `switch.rs` moves it, so language servers
//! index what a review shows.
use std::path::{Path, PathBuf};

use gix::ObjectId;
use gix::bstr::ByteSlice;

use super::diff::sides::{GITLINK, kind};
use super::diff::{PathChange, index_changes, tree_changes, worktree_changes};
use super::{GitRepo, native_path};
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
    /// a switch keeps them, and refuses when one would be overwritten. Submodules do not either:
    /// a switch leaves them alone, so one whose recorded commit it changed reads as modified.
    pub async fn is_clean(&self) -> Result<bool, GitError> {
        let root = self.root.clone();
        self.gix("status", move |repo| {
            let head = head_tree(repo)?;
            let (unstaged, conflicted) = worktree_changes(repo, &root, head)?;
            // Staged changes count even where the worktree matches HEAD again.
            Ok(!conflicted && unstaged.iter().chain(&index_changes(repo, head)?).all(is_submodule))
        })
        .await
    }

    /// Where HEAD is: on a branch, or detached at a commit; none in an unborn repository's detached HEAD.
    pub async fn current_checkout(&self) -> Result<Option<CheckoutTarget>, GitError> {
        self.gix("reading HEAD", |repo| {
            if let Some(branch) = branch(repo)? {
                return Ok(Some(CheckoutTarget::Branch(branch)));
            }
            Ok(repo.head_id().ok().map(|id| CheckoutTarget::Detached(id.to_string())))
        })
        .await
    }

    /// Whether HEAD already is `target`: on that branch, or at that commit, attached or not.
    pub async fn checked_out(&self, target: &CheckoutTarget) -> Result<bool, GitError> {
        let target = target.clone();
        self.gix("reading HEAD", move |repo| {
            Ok(match target {
                CheckoutTarget::Branch(name) => branch(repo)?.is_some_and(|b| b == name),
                CheckoutTarget::Detached(sha) => repo.head_id().is_ok_and(|id| id == sha.as_str()),
            })
        })
        .await
    }

    /// Moves HEAD and the worktree to `target`. Refuses, leaving everything as it was, when a
    /// change or an untracked file would be lost, or the branch is checked out in another worktree.
    pub async fn switch(&self, target: &CheckoutTarget) -> Result<(), GitError> {
        let (target, root) = (target.clone(), self.root.clone());
        self.gix("switch", move |repo| super::switch::switch(repo, &root, &target)).await
    }

    /// Whether `branch` is checked out in another worktree of this repository, where git refuses to
    /// switch to it.
    pub async fn checked_out_elsewhere(&self, branch: &str) -> Result<bool, GitError> {
        let (branch, root) = (branch.to_owned(), self.root.clone());
        self.gix("listing worktrees", move |repo| Ok(holder(repo, &root, &branch)?.is_some())).await
    }

    /// The files that differ between two commits, as moving the checkout from `old` to `new` touches them.
    pub async fn touched_between(&self, old: &str, new: &str) -> Result<Vec<(String, Touched)>, GitError> {
        let (old, new) = (old.to_owned(), new.to_owned());
        self.gix("diff", move |repo| {
            let tree = |rev: &str| -> anyhow::Result<ObjectId> {
                Ok(repo.rev_parse_single(rev)?.object()?.peel_to_tree()?.id)
            };
            Ok(tree_changes(repo, tree(&old)?, tree(&new)?)?
                .into_iter()
                .flat_map(|(old, new)| match (old, new) {
                    (None, Some(n)) => vec![(n.path, Touched::Created)],
                    (Some(o), None) => vec![(o.path, Touched::Deleted)],
                    // A file turned symlink (or back) is a deletion and a creation, as git lists it.
                    (Some(o), Some(n)) if kind(o.mode) != kind(n.mode) => {
                        vec![(o.path, Touched::Deleted), (n.path, Touched::Created)]
                    }
                    (Some(o), Some(_)) => vec![(o.path, Touched::Changed)],
                    (None, None) => Vec::new(),
                })
                .map(|(path, touched)| (path.to_string(), touched))
                .collect())
        })
        .await
    }
}

/// The local branch HEAD is on, by its short name, born or not.
pub(super) fn branch(repo: &gix::Repository) -> anyhow::Result<Option<String>> {
    Ok(repo
        .head_name()?
        .and_then(|name| name.as_bstr().strip_prefix(b"refs/heads/").map(|b| b.to_str_lossy().into_owned())))
}

pub(super) fn head_tree(repo: &gix::Repository) -> anyhow::Result<ObjectId> {
    Ok(repo.head_tree_id_or_empty()?.detach())
}

pub(super) fn is_submodule((old, new): &PathChange) -> bool {
    [old, new].into_iter().flatten().any(|item| kind(item.mode) == GITLINK)
}

/// The other worktree that has `branch` checked out, if any.
pub(super) fn holder(repo: &gix::Repository, root: &Path, branch: &str) -> anyhow::Result<Option<PathBuf>> {
    let mut others = vec![repo.main_repo()?];
    for proxy in repo.main_repo()?.worktrees()? {
        others.push(proxy.into_repo_with_possibly_inaccessible_worktree()?);
    }
    for other in others {
        let Some(workdir) = other.workdir().map(|dir| dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_owned()))
        else {
            continue;
        };
        if native_path(&workdir) != root && self::branch(&other)?.is_some_and(|b| b == branch) {
            return Ok(Some(workdir));
        }
    }
    Ok(None)
}
