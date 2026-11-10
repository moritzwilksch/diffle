//! Moving a clean checkout to another commit, written by gix's checkout. Nothing tracked can be lost, as it all matches HEAD,
//! so the switch refuses only what it cannot redo: a dirty or sparse checkout, a branch another
//! worktree holds, and anything on disk, untracked or ignored, where the target puts a file.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use anyhow::Context;
use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::index::entry::Flags;
use gix::worktree::stack::state::attributes::Source as AttributeSource;

use super::checkout::{CheckoutTarget, clean, holder, move_head};
use super::diff::sides::{GITLINK, Item, kind};
use super::diff::{PathChange, tree_changes};
use crate::error::GitError;

/// A refusal; nothing has changed yet.
macro_rules! refuse {
    ($($arg:tt)*) => { return Err(GitError::new(format!($($arg)*)).into()) };
}

/// Refuses unless the checkout is clean and nothing is in the target's way, then writes the paths
/// the two trees disagree on, the index to match, and HEAD.
pub(super) fn switch(repo: &gix::Repository, root: &Path, target: &CheckoutTarget) -> anyhow::Result<()> {
    let id = match target {
        CheckoutTarget::Branch(name) => {
            if let Some(path) = holder(repo, root, name)? {
                refuse!("'{name}' is already used by worktree at '{}'", path.display());
            }
            let mut branch = repo
                .find_reference(format!("refs/heads/{name}").as_str())
                .with_context(|| format!("invalid reference: {name}"))?;
            branch.peel_to_id()?.detach()
        }
        CheckoutTarget::Detached(sha) => repo.rev_parse_single(sha.as_str())?.object()?.peel_to_commit()?.id,
    };
    let index = repo.index_or_empty()?;
    if index.is_sparse() || index.entries().iter().any(|e| e.flags.contains(Flags::SKIP_WORKTREE)) {
        refuse!("a sparse checkout is left as it is");
    }
    // Checked again here: the worktree may have changed since the caller looked.
    if !clean(repo)? {
        refuse!("the worktree has uncommitted changes");
    }
    let target_tree = repo.find_commit(id)?.tree_id()?.detach();
    let changes = tree_changes(repo, repo.head_tree_id_or_empty()?.detach(), target_tree)?;
    refuse_in_the_way(root, &changes)?;
    let checked_out = write_worktree(repo, root, target_tree, &changes)?;
    write_index(&index, &checked_out, &changes)?;
    move_head(repo, target, id)
}

/// Refuses when the target puts a file where something HEAD does not track is on disk: at its
/// path, at a directory above it, or inside a directory it replaces. Ignored files count too.
fn refuse_in_the_way(root: &Path, changes: &[PathChange]) -> anyhow::Result<()> {
    let removed: HashSet<&[u8]> = deleted(changes).map(|old| old.path.as_slice()).collect();
    let in_the_way = |path: &[u8]| -> anyhow::Result<()> {
        refuse!("an untracked or ignored file is in the way: {}", path.as_bstr())
    };
    // A submodule's directory is left for its own checkout.
    for (old, new) in
        changes.iter().filter_map(|(o, n)| Some((o, n.as_ref()?))).filter(|(_, n)| kind(n.mode) != GITLINK)
    {
        let abs = root.join(native(&new.path)?);
        if let Ok(meta) = std::fs::symlink_metadata(&abs) {
            if meta.is_dir() {
                if let Some(kept) = kept_file(&abs, &new.path, &removed)? {
                    in_the_way(&kept)?;
                }
            } else if old.is_none() {
                in_the_way(&new.path)?;
            }
        }
        let mut dir = new.path.as_slice();
        while let Some(slash) = dir.rfind_byte(b'/') {
            dir = &dir[..slash];
            let meta = std::fs::symlink_metadata(root.join(native(dir)?));
            if meta.is_ok_and(|m| !m.is_dir()) && !removed.contains(dir) {
                in_the_way(dir)?;
            }
        }
    }
    Ok(())
}

/// What the switch deletes from disk: a path the target lacks, or holds as another kind.
fn deleted(changes: &[PathChange]) -> impl Iterator<Item = &Item> {
    changes.iter().filter_map(|(o, n)| o.as_ref().filter(|o| n.as_ref().is_none_or(|n| kind(n.mode) != kind(o.mode))))
}

/// A file under the directory at `rel` that the switch does not delete, which keeps it in place.
fn kept_file(abs: &Path, rel: &[u8], removed: &HashSet<&[u8]>) -> anyhow::Result<Option<Vec<u8>>> {
    for entry in std::fs::read_dir(abs)? {
        let entry = entry?;
        let mut child = rel.to_vec();
        child.push(b'/');
        child.extend_from_slice(&gix::path::into_bstr(PathBuf::from(entry.file_name()))?);
        let found = if entry.file_type()?.is_dir() {
            kept_file(&entry.path(), &child, removed)?
        } else {
            (!removed.contains(child.as_slice())).then_some(child)
        };
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// Removes what the target lacks, then has gix check out what it adds or changes, through the
/// smudge filters its own `.gitattributes` name. Returns the target's index, its checked-out
/// entries carrying fresh stat data.
fn write_worktree(
    repo: &gix::Repository,
    root: &Path,
    target_tree: ObjectId,
    changes: &[PathChange],
) -> anyhow::Result<gix::index::File> {
    // A missing object refuses the switch before anything on disk changes, not halfway through.
    for new in changes.iter().filter_map(|(_, n)| n.as_ref()).filter(|n| kind(n.mode) != GITLINK) {
        if !repo.has_object(new.id) {
            refuse!("{} is missing from the object database; fetch it first", new.id);
        }
    }
    for old in deleted(changes) {
        let abs = root.join(native(&old.path)?);
        // A submodule's checkout is left in place; an emptied one goes.
        let _ = if kind(old.mode) == GITLINK { std::fs::remove_dir(&abs) } else { std::fs::remove_file(&abs) };
        prune_empty_parents(root, &abs);
    }
    let written: HashSet<&[u8]> = changes.iter().filter_map(|(_, n)| n.as_ref()).map(|n| n.path.as_slice()).collect();
    let mut target = repo.index_from_tree(&target_tree)?;
    // Paths both sides agree on are on disk already: gix's checkout passes over skipped entries.
    for (entry, path) in target.entries_mut_with_paths() {
        if !written.contains(path.as_bytes()) {
            entry.flags.insert(Flags::SKIP_WORKTREE);
        }
    }
    let mut options = repo.checkout_options(AttributeSource::IdMapping)?;
    // `refuse_in_the_way` left only what the switch may replace where a file goes.
    options.overwrite_existing = true;
    let progress = gix::progress::Discard;
    let objects = repo.objects.clone().into_arc()?;
    let outcome = gix::worktree::state::checkout(
        &mut target,
        root,
        objects,
        &progress,
        &progress,
        &AtomicBool::new(false),
        options,
    )?;
    if let Some(failed) = outcome.errors.first() {
        anyhow::bail!("could not write {}: {}", failed.path, failed.error);
    }
    Ok(target)
}

fn prune_empty_parents(root: &Path, file: &Path) {
    let mut dir = file.parent();
    while let Some(d) = dir.filter(|d| *d != root && d.starts_with(root)) {
        if std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

/// The index moved to the target: the changed paths get the target's entries with the stat data
/// the checkout recorded; every other entry, which matches both HEAD and the target, keeps its own.
fn write_index(index: &gix::index::File, target: &gix::index::State, changes: &[PathChange]) -> anyhow::Result<()> {
    let mut index = index.clone();
    let changed: HashSet<&[u8]> =
        changes.iter().filter_map(|(o, n)| n.as_ref().or(o.as_ref())).map(|i| i.path.as_slice()).collect();
    index.remove_entries(|_, path, _| changed.contains(path.as_bytes()));
    for new in changes.iter().filter_map(|(_, n)| n.as_ref()) {
        let entry = target.entry_by_path(new.path.as_bstr()).context("a checked-out entry")?;
        index.dangerously_push_entry(entry.stat, entry.id, Flags::empty(), entry.mode, new.path.as_bstr());
    }
    index.sort_entries();
    // The cache-tree describes the old entries; git rebuilds it on the next write-tree.
    index.remove_tree();
    index.write(Default::default())?;
    Ok(())
}

fn native(path: &[u8]) -> anyhow::Result<std::borrow::Cow<'_, Path>> {
    Ok(gix::path::from_bstr(path.as_bstr())?)
}
