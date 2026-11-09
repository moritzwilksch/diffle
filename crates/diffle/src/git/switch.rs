//! `git switch`, in-process: the refusals git makes, decided before anything on disk changes, then
//! the paths the two trees disagree on, the index and HEAD.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::Context;
use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat};
use gix::worktree::stack::state::attributes::Source as AttributeSource;

use super::checkout::{CheckoutTarget, head_tree, holder, is_submodule, move_head};
use super::diff::sides::{EXECUTABLE, GITLINK, Item, SYMLINK, kind};
use super::diff::{PathChange, index_changes, tree_changes, worktree_changes};
use crate::error::GitError;

/// A refusal, worded as git words it; nothing has changed yet.
macro_rules! refuse {
    ($($arg:tt)*) => { return Err(GitError::new(format!($($arg)*)).into()) };
}

/// `git switch`: refuses what git refuses, then writes the paths the two trees disagree on, the
/// index to match the target, and HEAD.
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
    if index.is_sparse() {
        refuse!("a sparse index is not supported; switch by hand");
    }
    let target_tree = repo.find_commit(id)?.tree_id()?.detach();
    let changes = tree_changes(repo, head_tree(repo)?, target_tree)?;
    let skipped = skipped(&index, &changes);
    refuse_losses(repo, root, &index, &changes, &skipped)?;
    write_worktree(repo, root, target_tree, &changes, &skipped)?;
    write_index(root, &index, &changes, &skipped)?;
    move_head(repo, target, id)
}

/// The changed paths sparse checkout leaves off disk: those the index marks skip-worktree, and a
/// new one where every tracked path in its nearest tracked directory is, as a cone leaves them.
fn skipped(index: &gix::index::File, changes: &[PathChange]) -> HashSet<BString> {
    let entries = index.entries();
    if !entries.iter().any(|e| e.flags.contains(Flags::SKIP_WORKTREE)) {
        return HashSet::new();
    }
    let skip = |path: &BStr| -> bool {
        if let Some(entry) = index.entry_by_path(path) {
            return entry.flags.contains(Flags::SKIP_WORKTREE);
        }
        let mut dir = path;
        while let Some(slash) = dir.rfind_byte(b'/') {
            dir = &dir[..slash];
            let prefix = [dir.as_bytes(), b"/"].concat();
            let start = entries.partition_point(|e| e.path(index).as_bytes() < prefix.as_slice());
            let mut under = entries[start..].iter().take_while(|e| e.path(index).starts_with(&prefix)).peekable();
            if under.peek().is_some() {
                return under.all(|e| e.flags.contains(Flags::SKIP_WORKTREE));
            }
        }
        false
    };
    changes
        .iter()
        .filter_map(|(o, n)| n.as_ref().or(o.as_ref()))
        .map(|i| &i.path)
        .filter(|p| skip(p.as_bstr()))
        .cloned()
        .collect()
}

/// Git's refusals, checked for every path the switch would write before any is written: a local
/// change, staged or not, to a path it rewrites, or an untracked file, not ignored, where it puts one.
fn refuse_losses(
    repo: &gix::Repository,
    root: &Path,
    index: &gix::index::File,
    changes: &[PathChange],
    skipped: &HashSet<BString>,
) -> anyhow::Result<()> {
    let head = head_tree(repo)?;
    let (unstaged, _) = worktree_changes(repo, root, head)?;
    let dirty: HashSet<BString> = unstaged
        .into_iter()
        .chain(index_changes(repo, head)?)
        .filter(|c| !is_submodule(c))
        .filter_map(|(o, n)| o.or(n))
        .map(|i| i.path)
        .collect();
    let local: Vec<_> =
        changes.iter().filter_map(|(o, n)| o.as_ref().or(n.as_ref())).filter(|i| dirty.contains(&i.path)).collect();
    if let Some(item) = local.first() {
        refuse!("Your local changes to the following files would be overwritten by checkout: {}", item.path);
    }
    let mut excludes =
        repo.excludes(index, None, gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped)?;
    let tracked = |path: &[u8]| index.entry_by_path(path.as_bstr()).is_some();
    // Only what the switch deletes is out of the way by the time a path changes kind; a staged
    // file it keeps would stop it halfway, the worktree rewritten but the index and HEAD not.
    let removed: HashSet<&[u8]> = deleted(changes.iter()).map(|old| old.path.as_slice()).collect();
    let refuse_kept = |path: &[u8]| -> anyhow::Result<()> {
        if tracked(path) {
            refuse!("Your local changes to the following files would be overwritten by checkout: {}", path.as_bstr());
        }
        refuse!("The following untracked working tree files would be overwritten by checkout: {}", path.as_bstr())
    };
    let written = changes.iter().filter_map(|(_, n)| n.as_ref()).filter(|n| !skipped.contains(&n.path));
    for new in written.filter(|n| kind(n.mode) != GITLINK) {
        // The path itself, then each directory above it, must be free or git's to replace.
        let (mut path, mut own): (&[u8], bool) = (&new.path, true);
        loop {
            let abs = root.join(native(path)?);
            if let Ok(meta) = std::fs::symlink_metadata(&abs) {
                match (own, meta.is_dir()) {
                    // A directory where the file goes is git's to remove once the files it deletes there are gone.
                    (true, true) => {
                        if let Some(kept) = kept_file(&abs, path, &removed)? {
                            refuse_kept(&kept)?;
                        }
                    }
                    (true, false) if !tracked(path) && !excludes.at_entry(path.as_bstr(), None)?.is_excluded() => {
                        refuse_kept(path)?;
                    }
                    (false, false) if !removed.contains(path) => refuse_kept(path)?,
                    _ => {}
                }
            }
            let Some(slash) = path.rfind_byte(b'/') else { break };
            (path, own) = (&path[..slash], false);
        }
    }
    Ok(())
}

/// What the switch deletes from disk: a path the target lacks, or holds as another kind.
fn deleted<'a>(changes: impl Iterator<Item = &'a PathChange>) -> impl Iterator<Item = &'a Item> {
    changes.filter_map(|(o, n)| o.as_ref().filter(|o| n.as_ref().is_none_or(|n| kind(n.mode) != kind(o.mode))))
}

/// A file under the directory at `rel` that the switch does not delete, which would keep it in place.
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

/// Removes what the target lacks, then writes what it adds or changes, through the smudge filters
/// the target's `.gitattributes` name, as git reads them from the index it checks out; paths
/// sparse checkout skips stay off disk.
fn write_worktree(
    repo: &gix::Repository,
    root: &Path,
    target_tree: ObjectId,
    changes: &[PathChange],
    skipped: &HashSet<BString>,
) -> anyhow::Result<()> {
    let changes: Vec<_> =
        changes.iter().filter(|(o, n)| !skipped.contains(&n.as_ref().or(o.as_ref()).expect("a side").path)).collect();
    for old in deleted(changes.iter().copied()) {
        let abs = root.join(native(&old.path)?);
        // A submodule's checkout is left in place, as git leaves it; an emptied one goes.
        let _ = if kind(old.mode) == GITLINK { std::fs::remove_dir(&abs) } else { std::fs::remove_file(&abs) };
        prune_empty_parents(root, &abs);
    }
    let target_index = repo.index_from_tree(&target_tree)?;
    let attributes = repo.attributes_only(&target_index, AttributeSource::IdMapping)?;
    let mut pipeline = gix::filter::Pipeline::new(repo, attributes.detach())?;
    let symlinks = repo.filesystem_options()?.symlink;
    for new in changes.iter().filter_map(|(_, n)| n.as_ref()) {
        let abs = root.join(native(&new.path)?);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if kind(new.mode) == GITLINK {
            std::fs::create_dir_all(&abs)?;
            continue;
        }
        if let Ok(meta) = std::fs::symlink_metadata(&abs) {
            if meta.is_dir() { remove_empty_dirs(&abs)? } else { std::fs::remove_file(&abs)? }
        }
        write_file(repo, &mut pipeline, new, &abs, symlinks)?;
    }
    Ok(())
}

fn write_file(
    repo: &gix::Repository,
    pipeline: &mut gix::filter::Pipeline<'_>,
    item: &Item,
    abs: &Path,
    symlinks: bool,
) -> anyhow::Result<()> {
    use gix::filter::plumbing::driver::apply::MaybeDelayed;
    use gix::filter::plumbing::pipeline::convert::ToWorktreeOutcome;
    let blob = repo.find_object(item.id)?.detach().data;
    // Without symlinks (`core.symlinks=false`) a link is a plain file holding its target, as git writes it.
    if item.mode == SYMLINK && symlinks {
        #[cfg(unix)]
        return Ok(std::os::unix::fs::symlink(gix::path::from_bstr(blob.as_bstr())?, abs)?);
    }
    let content = match pipeline.convert_to_worktree(&blob, item.path.as_bstr(), Default::default())? {
        ToWorktreeOutcome::Unchanged(bytes) | ToWorktreeOutcome::Buffer(bytes) => bytes.to_vec(),
        ToWorktreeOutcome::Process(MaybeDelayed::Immediate(mut read)) => {
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut read, &mut buf)?;
            buf
        }
        ToWorktreeOutcome::Process(MaybeDelayed::Delayed(_)) => {
            anyhow::bail!("a delayed filter cannot write {}", item.path)
        }
    };
    std::fs::write(abs, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(abs)?.permissions().mode();
        let mode = if item.mode == EXECUTABLE { mode | ((mode & 0o444) >> 2) } else { mode & !0o111 };
        std::fs::set_permissions(abs, std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

/// The index moved to the target: the paths the switch changed get the target's entries, and
/// every other entry stays as it was, its flags (skip-worktree, intent-to-add), stat data and
/// staged content included, as git's two-way merge keeps them.
fn write_index(
    root: &Path,
    index: &gix::index::File,
    changes: &[PathChange],
    skipped: &HashSet<BString>,
) -> anyhow::Result<()> {
    let mut index = index.clone();
    let changed: HashSet<&[u8]> =
        changes.iter().filter_map(|(o, n)| n.as_ref().or(o.as_ref())).map(|i| i.path.as_slice()).collect();
    index.remove_entries(|_, path, _| changed.contains(path.as_bytes()));
    for new in changes.iter().filter_map(|(_, n)| n.as_ref()) {
        let skip = skipped.contains(&new.path);
        let meta = if skip {
            None
        } else {
            gix::index::fs::Metadata::from_path_no_follow(&root.join(native(&new.path)?)).ok()
        };
        let stat = meta.map_or(Ok(Stat::default()), |meta| Stat::from_fs(&meta))?;
        // An extended flag is written only with `EXTENDED` set, which also makes the index version 3.
        let flags = if skip { Flags::SKIP_WORKTREE | Flags::EXTENDED } else { Flags::empty() };
        let mode = Mode::from_bits(new.mode).context("a tree entry's mode")?;
        index.dangerously_push_entry(stat, new.id, flags, mode, new.path.as_bstr());
    }
    index.sort_entries();
    // The cache-tree describes the old entries; git rebuilds it on the next write-tree.
    index.remove_tree();
    index.write(Default::default())?;
    Ok(())
}

/// Removes a directory holding no files, only directories, as `refuse_losses` saw to.
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

fn native(path: &[u8]) -> anyhow::Result<std::borrow::Cow<'_, Path>> {
    Ok(gix::path::from_bstr(path.as_bstr())?)
}
