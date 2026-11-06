//! Revisions, commit metadata, merge bases, and the refs that pin iterations.
use gix::bstr::ByteSlice;
use gix::objs::Kind;

use super::{GitRepo, refs};
use crate::error::{GitError, Result};
use crate::protocol::{CommitInfo, LastCommitsPreview};
use gix::ObjectId;
use gix::merge::blob::builtin_driver::text::Labels;
use gix::merge::tree::TreatAsUnresolved;
use gix::merge::tree::apply_index_entries::RemovalMode;

impl GitRepo {
    /// Commit sha for a user-supplied revision; a revision that names no commit is missing.
    pub async fn resolve(&self, rev: &str) -> Result<String, GitError> {
        self.peeled(rev, Kind::Commit).await
    }

    /// `resolve`, with none for a revision that names nothing.
    pub async fn try_resolve(&self, rev: &str) -> Result<Option<String>, GitError> {
        match self.resolve(rev).await {
            Ok(sha) => Ok(Some(sha)),
            Err(e) if e.is_missing() => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The tree a commit points at.
    pub async fn tree(&self, rev: &str) -> Result<String, GitError> {
        self.peeled(rev, Kind::Tree).await
    }

    /// `rev` peeled to an object of `kind`, as `rev-parse --verify --quiet rev^{kind}`: any failure is missing.
    async fn peeled(&self, rev: &str, kind: Kind) -> Result<String, GitError> {
        let owned = rev.to_owned();
        let found = self
            .gix("rev-parse", move |repo| {
                let Ok(id) = repo.rev_parse_single(owned.as_str()) else { return Ok(None) };
                Ok(id.object()?.peel_to_kind(kind).ok().map(|o| o.id.to_string()))
            })
            .await?;
        found.ok_or_else(|| GitError {
            code: Some(1),
            ..GitError::refused(format!("unknown revision: {rev}"), &["rev-parse", "--verify", rev])
        })
    }

    /// Commit messages for two ancestor offsets, pinned to one HEAD.
    pub async fn last_commits_preview(&self, old_offset: u64, new_offset: u64) -> Result<LastCommitsPreview> {
        let Some(head) = self.commit_info("HEAD").await? else {
            return Ok(LastCommitsPreview { old: None, new: None });
        };
        let at = |offset: u64| {
            let head = head.clone();
            async move {
                if offset == 0 { Ok(Some(head)) } else { self.commit_info(&format!("{}~{offset}", head.sha)).await }
            }
        };
        let (old, new) = tokio::try_join!(at(old_offset), at(new_offset))?;
        Ok(LastCommitsPreview { old, new })
    }

    /// A commit's hash, abbreviation and full message; none when `rev` names no commit.
    pub async fn commit_info(&self, rev: &str) -> Result<Option<CommitInfo>, GitError> {
        let Some(sha) = self.try_resolve(rev).await? else {
            return Ok(None);
        };
        self.gix("reading a commit", move |repo| {
            let commit = repo.find_commit(gix::ObjectId::from_hex(sha.as_bytes())?)?;
            let message = commit.message_raw_sloppy().to_str_lossy().trim_end().to_owned();
            Ok(Some(CommitInfo { short: commit.id().shorten_or_id().to_string(), message, sha }))
        })
        .await
    }

    /// The empty tree under the repository's hash algorithm: the old side of an unborn branch.
    pub async fn empty_tree(&self) -> Result<String, GitError> {
        self.gix("hashing the empty tree", |repo| Ok(gix::ObjectId::empty_tree(repo.object_hash()).to_string())).await
    }

    pub async fn merge_base(&self, a: &str, b: &str) -> Result<String, GitError> {
        let (a, b) = (a.to_owned(), b.to_owned());
        self.gix("merge-base", move |repo| {
            let (a, b) = (repo.rev_parse_single(a.as_str())?, repo.rev_parse_single(b.as_str())?);
            let base = repo.merge_base(a, b)?.ok_or_else(|| anyhow::anyhow!("no merge base between {a} and {b}"))?;
            Ok(base.to_string())
        })
        .await
    }

    /// Replays what `head` changed since `base` onto `onto`, as `git merge-tree` would: the
    /// resulting tree, written to the object database, and the paths the merge could not settle,
    /// which the tree holds with conflict markers labelled with `onto` and `head`.
    pub async fn replay(&self, base: &str, onto: &str, head: &str) -> Result<(String, Vec<String>), GitError> {
        let (base, onto, head) = (base.to_owned(), onto.to_owned(), head.to_owned());
        self.gix("merge-tree", move |repo| {
            let tree = |rev: &str| -> anyhow::Result<ObjectId> {
                Ok(repo.rev_parse_single(rev)?.object()?.peel_to_tree()?.id)
            };
            let labels = Labels {
                ancestor: Some(base.as_str().into()),
                current: Some(onto.as_str().into()),
                other: Some(head.as_str().into()),
            };
            let mut merged =
                repo.merge_trees(tree(&base)?, tree(&onto)?, tree(&head)?, labels, repo.tree_merge_options()?)?;
            let id = merged.tree.write()?.detach();
            // The conflicted paths are those the merge leaves at a stage, as git's index would hold them.
            let mut index = repo.index_from_tree(&id)?;
            merged.index_changed_after_applying_conflicts(&mut index, TreatAsUnresolved::git(), RemovalMode::Prune);
            let mut conflicts: Vec<String> =
                index.entries().iter().filter(|e| e.stage_raw() != 0).map(|e| e.path(&index).to_string()).collect();
            conflicts.dedup();
            Ok((id.to_string(), conflicts))
        })
        .await
    }

    /// Points refs at objects so they survive `gc` and a force-push, or with none deletes them.
    /// Refs must stay inside `refs/diffle/iterations/`: nothing the user owns moves.
    pub async fn pin(&self, refs: &[(String, Option<String>)]) -> Result<(), GitError> {
        if let Some((name, _)) = refs.iter().find(|(name, _)| !name.starts_with("refs/diffle/iterations/")) {
            return Err(GitError::refused(format!("refusing to update {name}"), &["update-ref"]));
        }
        let refs = refs.to_vec();
        self.gix("update-ref", move |repo| {
            let edits = refs
                .into_iter()
                .map(|(name, sha)| match sha {
                    Some(sha) => refs::update(&name, gix::ObjectId::from_hex(sha.as_bytes())?),
                    None => refs::delete(&name),
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            if !edits.is_empty() {
                repo.edit_references(edits)?;
            }
            Ok(())
        })
        .await
    }
}
