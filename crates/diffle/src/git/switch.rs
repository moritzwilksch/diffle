//! `git switch`, in-process: the refusals git makes, decided before anything on disk changes, then
//! the paths the two trees disagree on, the index and HEAD.
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::Context;
use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stat};
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};

use super::checkout::{CheckoutTarget, branch, head_tree, holder, is_submodule};
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
    write_worktree(repo, root, &changes, &skipped)?;
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
    let written = changes.iter().filter_map(|(_, n)| n.as_ref()).filter(|n| !skipped.contains(&n.path));
    for new in written.filter(|n| kind(n.mode) != GITLINK) {
        // The path itself, then each directory above it, must be free or git's to replace.
        let (mut path, mut own): (&[u8], bool) = (&new.path, true);
        loop {
            let abs = root.join(native(path)?);
            if let Ok(meta) = std::fs::symlink_metadata(&abs) {
                let in_way = match (own, meta.is_dir()) {
                    // A directory where the file goes is git's to remove once the files it tracks there are gone.
                    (true, true) => holds_untracked(&abs, path, &tracked)?,
                    (true, false) => !tracked(path) && !excludes.at_entry(path.as_bstr(), None)?.is_excluded(),
                    (false, dir) => !dir && !tracked(path),
                };
                if in_way {
                    refuse!(
                        "The following untracked working tree files would be overwritten by checkout: {}",
                        path.as_bstr()
                    );
                }
            }
            let Some(slash) = path.rfind_byte(b'/') else { break };
            (path, own) = (&path[..slash], false);
        }
    }
    Ok(())
}

/// Whether the directory at `rel` holds a file the index does not track.
fn holds_untracked(abs: &Path, rel: &[u8], tracked: &dyn Fn(&[u8]) -> bool) -> anyhow::Result<bool> {
    for entry in std::fs::read_dir(abs)? {
        let entry = entry?;
        let mut child = rel.to_vec();
        child.push(b'/');
        child.extend_from_slice(&gix::path::into_bstr(PathBuf::from(entry.file_name()))?);
        let found = if entry.file_type()?.is_dir() {
            holds_untracked(&entry.path(), &child, tracked)?
        } else {
            !tracked(&child)
        };
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Removes what the target lacks, then writes what it adds or changes, through the smudge filters;
/// paths sparse checkout skips stay off disk.
fn write_worktree(
    repo: &gix::Repository,
    root: &Path,
    changes: &[PathChange],
    skipped: &HashSet<BString>,
) -> anyhow::Result<()> {
    let changes: Vec<_> =
        changes.iter().filter(|(o, n)| !skipped.contains(&n.as_ref().or(o.as_ref()).expect("a side").path)).collect();
    for old in changes
        .iter()
        .filter(|(o, n)| o.is_some() && n.as_ref().is_none_or(|n| kind(n.mode) != kind(o.as_ref().unwrap().mode)))
    {
        let old = old.0.as_ref().expect("filtered");
        let abs = root.join(native(&old.path)?);
        // A submodule's checkout is left in place, as git leaves it; an emptied one goes.
        let _ = if kind(old.mode) == GITLINK { std::fs::remove_dir(&abs) } else { std::fs::remove_file(&abs) };
        prune_empty_parents(root, &abs);
    }
    let (mut pipeline, _) = repo.filter_pipeline(None)?;
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
            if meta.is_dir() { std::fs::remove_dir(&abs)? } else { std::fs::remove_file(&abs)? }
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

/// Points HEAD at the branch, or detaches it at the commit, and logs the move in HEAD's reflog as
/// git does, where `@{-N}` finds the branches checked out before.
fn move_head(repo: &gix::Repository, target: &CheckoutTarget, id: ObjectId) -> anyhow::Result<()> {
    let mut repo = repo.clone();
    repo.committer_or_set_fallback("diffle", "diffle@localhost")?;
    let previous = repo.head_id().ok().map(gix::Id::detach);
    let from = branch(&repo)?.or_else(|| previous.map(|id| id.to_string())).unwrap_or_default();
    let (to, new) = match target {
        CheckoutTarget::Branch(name) => {
            (name.clone(), gix::refs::Target::Symbolic(format!("refs/heads/{name}").try_into()?))
        }
        CheckoutTarget::Detached(_) => (id.to_string(), gix::refs::Target::Object(id)),
    };
    let message = format!("checkout: moving from {from} to {to}");
    let log_path = repo.git_dir().join("logs").join("HEAD");
    let logged = std::fs::metadata(&log_path).map_or(0, |m| m.len());
    let log = LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: message.clone().into() };
    let edit = RefEdit {
        change: Change::Update { log, expected: PreviousValue::Any, new },
        name: "HEAD".try_into()?,
        deref: false,
    };
    repo.edit_reference(edit)?;
    // gix logs a move to a commit but not one onto a branch.
    if std::fs::metadata(&log_path).map_or(0, |m| m.len()) == logged {
        let old = previous.unwrap_or_else(|| ObjectId::null(repo.object_hash()));
        let mut who = Vec::new();
        repo.committer().transpose()?.context("a committer")?.write_to(&mut who)?;
        let line = format!("{old} {id} {}\t{message}\n", who.as_bstr());
        std::fs::create_dir_all(log_path.parent().expect("a logs directory"))?;
        std::io::Write::write_all(
            &mut std::fs::OpenOptions::new().create(true).append(true).open(&log_path)?,
            line.as_bytes(),
        )?;
    }
    Ok(())
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
