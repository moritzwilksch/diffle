//! Moving a clean checkout to another commit. Nothing tracked can be lost, as it all matches HEAD,
//! so the switch refuses only what it cannot redo: a dirty or sparse checkout, a branch another
//! worktree holds, and anything on disk, untracked or ignored, where the target puts a file.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::Context;
use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat};
use gix::worktree::stack::state::attributes::Source as AttributeSource;

use super::checkout::{CheckoutTarget, clean, holder, move_head};
use super::diff::sides::{EXECUTABLE, GITLINK, Item, SYMLINK, kind};
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
    if !clean(repo, root)? {
        refuse!("the worktree has uncommitted changes");
    }
    let target_tree = repo.find_commit(id)?.tree_id()?.detach();
    let changes = tree_changes(repo, repo.head_tree_id_or_empty()?.detach(), target_tree)?;
    refuse_in_the_way(root, &changes)?;
    write_worktree(repo, root, target_tree, &changes)?;
    write_index(root, &index, &changes)?;
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

/// Removes what the target lacks, then writes what it adds or changes through the smudge filters
/// its own `.gitattributes` name. Every blob is read and filtered first, so a missing object or a
/// failing filter refuses the switch instead of halting it midway.
fn write_worktree(
    repo: &gix::Repository,
    root: &Path,
    target_tree: ObjectId,
    changes: &[PathChange],
) -> anyhow::Result<()> {
    let target_index = repo.index_from_tree(&target_tree)?;
    let attributes = repo.attributes_only(&target_index, AttributeSource::IdMapping)?;
    let mut pipeline = gix::filter::Pipeline::new(repo, attributes.detach())?;
    let symlinks = repo.filesystem_options()?.symlink;
    let written = changes
        .iter()
        .filter_map(|(_, n)| n.as_ref())
        .map(|new| Ok((root.join(native(&new.path)?), render(repo, &mut pipeline, new, symlinks)?)))
        .collect::<anyhow::Result<Vec<_>>>()?;
    for old in deleted(changes) {
        let abs = root.join(native(&old.path)?);
        // A submodule's checkout is left in place; an emptied one goes.
        let _ = if kind(old.mode) == GITLINK { std::fs::remove_dir(&abs) } else { std::fs::remove_file(&abs) };
        prune_empty_parents(root, &abs);
    }
    for (abs, content) in written {
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Content::Submodule = content {
            std::fs::create_dir_all(&abs)?;
            continue;
        }
        if let Ok(meta) = std::fs::symlink_metadata(&abs) {
            // Only empty directories are left here: `refuse_in_the_way` saw to that.
            if meta.is_dir() { remove_empty_dirs(&abs)? } else { std::fs::remove_file(&abs)? }
        }
        put(&abs, content)?;
    }
    Ok(())
}

/// What the switch puts at one path, ready to write.
enum Content {
    /// A submodule's directory, left for its own checkout.
    Submodule,
    Symlink(BString),
    File {
        bytes: Vec<u8>,
        executable: bool,
    },
}

/// `item` as the worktree holds it: its blob through the smudge filters.
fn render(
    repo: &gix::Repository,
    pipeline: &mut gix::filter::Pipeline<'_>,
    item: &Item,
    symlinks: bool,
) -> anyhow::Result<Content> {
    use gix::filter::plumbing::driver::apply::MaybeDelayed;
    use gix::filter::plumbing::pipeline::convert::ToWorktreeOutcome;
    if kind(item.mode) == GITLINK {
        return Ok(Content::Submodule);
    }
    let blob = repo.find_object(item.id)?.detach().data;
    // Without symlinks (`core.symlinks=false`, or a platform without them) a link is a plain file
    // holding its target, as git writes it.
    if item.mode == SYMLINK && symlinks && cfg!(unix) {
        return Ok(Content::Symlink(blob.into()));
    }
    let bytes = match pipeline.convert_to_worktree(&blob, item.path.as_bstr(), Default::default())? {
        ToWorktreeOutcome::Unchanged(bytes) | ToWorktreeOutcome::Buffer(bytes) => bytes.to_vec(),
        ToWorktreeOutcome::Process(MaybeDelayed::Immediate(mut read)) => {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut read, &mut buf)?;
            buf
        }
        ToWorktreeOutcome::Process(MaybeDelayed::Delayed(_)) => {
            refuse!("a delayed filter cannot write {}; switch by hand", item.path)
        }
    };
    Ok(Content::File { bytes, executable: item.mode == EXECUTABLE })
}

fn put(abs: &Path, content: Content) -> anyhow::Result<()> {
    match content {
        Content::Submodule => Ok(()),
        #[cfg(unix)]
        Content::Symlink(target) => Ok(std::os::unix::fs::symlink(gix::path::from_bstr(target.as_bstr())?, abs)?),
        #[cfg(not(unix))]
        Content::Symlink(_) => unreachable!("rendered as a file without symlinks"),
        Content::File { bytes, executable } => {
            std::fs::write(abs, bytes)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(abs)?.permissions().mode();
                let mode = if executable { mode | ((mode & 0o444) >> 2) } else { mode & !0o111 };
                std::fs::set_permissions(abs, std::fs::Permissions::from_mode(mode))?;
            }
            #[cfg(not(unix))]
            let _ = executable;
            Ok(())
        }
    }
}

fn remove_empty_dirs(dir: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        remove_empty_dirs(&entry?.path())?;
    }
    std::fs::remove_dir(dir)
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

/// The index moved to the target: the changed paths get the target's entries with fresh stat
/// data; every other entry, which matches both HEAD and the target, keeps its own.
fn write_index(root: &Path, index: &gix::index::File, changes: &[PathChange]) -> anyhow::Result<()> {
    let mut index = index.clone();
    let changed: HashSet<&[u8]> =
        changes.iter().filter_map(|(o, n)| n.as_ref().or(o.as_ref())).map(|i| i.path.as_slice()).collect();
    index.remove_entries(|_, path, _| changed.contains(path.as_bytes()));
    for new in changes.iter().filter_map(|(_, n)| n.as_ref()) {
        let meta = gix::index::fs::Metadata::from_path_no_follow(&root.join(native(&new.path)?)).ok();
        let stat = meta.map_or(Ok(Stat::default()), |meta| Stat::from_fs(&meta))?;
        let mode = Mode::from_bits(new.mode).context("a tree entry's mode")?;
        index.dangerously_push_entry(stat, new.id, Flags::empty(), mode, new.path.as_bstr());
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
