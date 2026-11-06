//! What git tracks and stores: the index, a tree's paths, attributes, and the blobs git would
//! write for worktree content after its clean filters.
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use gix::attrs::StateRef;
use gix::bstr::BStr;
use gix::dir::entry::{Kind, Status};
use gix::dir::walk::EmissionMode;
use gix::dir::walk::delegate::Collect;
use gix::worktree::stack::state::attributes::Source;

use super::diff::sides::hash_to_git;
use super::{GitRepo, WORKTREE};
use crate::error::GitError;

impl GitRepo {
    /// Untracked files git does not ignore, sorted; a nested repository is `dir/`, as git has no
    /// diff for it.
    pub async fn untracked(&self) -> Result<Vec<String>, GitError> {
        self.gix("listing untracked files", |repo| {
            let options = repo.dirwalk_options()?.emit_untracked(EmissionMode::Matching).emit_ignored(None);
            walk(repo, options, |status| status == Status::Untracked)
        })
        .await
    }

    /// Ignored files and directories (directories end with '/'), sorted. Feeds the watcher.
    pub async fn ignored_paths(&self) -> Result<Vec<String>, GitError> {
        self.gix("listing ignored files", |repo| {
            let options = repo
                .dirwalk_options()?
                .emit_untracked(EmissionMode::Matching)
                .emit_ignored(Some(EmissionMode::CollapseDirectory));
            walk(repo, options, |status| matches!(status, Status::Ignored(_)))
        })
        .await
    }

    /// Every path in the index, once.
    pub async fn ls_files(&self) -> Result<Vec<String>, GitError> {
        self.gix("ls-files", |repo| {
            let index = repo.index_or_empty()?;
            let mut paths: Vec<String> = index.entries().iter().map(|e| e.path(&index).to_string()).collect();
            // A conflicted path has an entry per stage, side by side.
            paths.dedup();
            Ok(paths)
        })
        .await
    }

    /// Every path in a commit's tree, in git's order.
    pub async fn ls_tree(&self, rev: &str) -> Result<Vec<String>, GitError> {
        let rev = rev.to_owned();
        self.gix("ls-tree", move |repo| {
            let tree = repo.rev_parse_single(rev.as_str())?.object()?.peel_to_tree()?;
            let mut paths: Vec<_> = tree
                .traverse()
                .breadthfirst
                .files()?
                .into_iter()
                .filter(|e| !e.mode.is_tree())
                .map(|e| e.filepath)
                .collect();
            paths.sort();
            Ok(paths.into_iter().map(|p| p.to_string()).collect())
        })
        .await
    }

    /// Boolean value of a gitattribute per path: `attr` or `attr=true` reads true, `-attr` or
    /// `attr=false` false; unspecified paths are absent. A revision reads `.gitattributes` from
    /// that tree, the worktree from the checkout.
    pub async fn attr(&self, name: &str, paths: &[String], rev: &str) -> Result<HashMap<String, bool>, GitError> {
        if paths.is_empty() {
            return Ok(HashMap::new());
        }
        let (name, paths, rev) = (name.to_owned(), paths.to_vec(), rev.to_owned());
        self.gix("check-attr", move |repo| {
            let (shared, from_tree);
            let (index, source): (&gix::index::State, _) = if rev == WORKTREE {
                shared = repo.index_or_empty()?;
                (&shared, Source::WorktreeThenIdMapping)
            } else {
                let tree = repo.rev_parse_single(rev.as_str())?.object()?.peel_to_tree()?.id;
                from_tree = repo.index_from_tree(&tree)?;
                (&from_tree, Source::IdMapping)
            };
            let mut stack = repo.attributes_only(index, source)?;
            let mut outcome = stack.selected_attribute_matches([name.as_str()]);
            let mut out = HashMap::new();
            for path in paths {
                outcome.reset();
                stack.at_entry(path.as_str(), None)?.matching_attributes(&mut outcome);
                let value = outcome.iter_selected().next().and_then(|m| match m.assignment.state {
                    StateRef::Set => Some(true),
                    StateRef::Unset => Some(false),
                    StateRef::Value(v) if v.as_bstr() == "true" => Some(true),
                    StateRef::Value(v) if v.as_bstr() == "false" => Some(false),
                    _ => None,
                });
                if let Some(value) = value {
                    out.insert(path, value);
                }
            }
            Ok(out)
        })
        .await
    }

    /// What git would store for `content` at worktree `path`, its clean filters applied: equals the
    /// snapshot's blob for a worktree file whose bytes are still the snapshot's.
    pub async fn hash_object(&self, content: &[u8], path: &str) -> Result<String, GitError> {
        let (content, path) = (content.to_vec(), path.to_owned());
        self.gix("hash-object", move |repo| {
            let (mut pipeline, index) = repo.filter_pipeline(None)?;
            let path = path.as_str().into();
            Ok(hash_to_git(repo, &mut pipeline, &index, &path, content.as_slice(), content.len() as u64)?.to_string())
        })
        .await
    }
}

/// The worktree entries `keep` selects, as repository-relative paths with a directory's ending in '/'.
fn walk(
    repo: &gix::Repository,
    options: gix::dirwalk::Options,
    keep: impl Fn(Status) -> bool,
) -> anyhow::Result<Vec<String>> {
    let index = repo.index_or_empty()?;
    let options = options.emit_tracked(false).recurse_repositories(false).emit_empty_directories(false);
    let mut collect = Collect::default();
    let none: [&BStr; 0] = [];
    repo.dirwalk(&index, none, &AtomicBool::new(false), options, &mut collect)?;
    let mut paths: Vec<String> = collect
        .unorded_entries
        .into_iter()
        .filter(|(entry, _)| keep(entry.status))
        .filter_map(|(entry, _)| match entry.disk_kind? {
            Kind::File | Kind::Symlink => Some(entry.rela_path.to_string()),
            Kind::Directory | Kind::Repository => Some(format!("{}/", entry.rela_path)),
            Kind::Untrackable => None,
        })
        .collect();
    paths.sort();
    Ok(paths)
}
