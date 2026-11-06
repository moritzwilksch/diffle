//! `git switch`, in-process: the refusals git makes, decided before anything on disk changes, then
//! the paths the two trees disagree on, the index and HEAD.
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::index::entry::Stat;
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};

use super::checkout::{CheckoutTarget, branch, head_tree, holder, is_submodule};
use super::diff::sides::{EXECUTABLE, GITLINK, Item, SYMLINK, kind};
use super::diff::{PathChange, tree_changes, worktree_changes};

/// `git switch`: refuses what git refuses, then writes the paths the two trees disagree on, the
/// index to match the target, and HEAD.
pub(super) fn switch(repo: &gix::Repository, root: &Path, target: &CheckoutTarget) -> anyhow::Result<()> {
    let id = match target {
        CheckoutTarget::Branch(name) => {
            if let Some(path) = holder(repo, root, name)? {
                bail!("'{name}' is already used by worktree at '{}'", path.display());
            }
            let mut branch = repo
                .find_reference(format!("refs/heads/{name}").as_str())
                .with_context(|| format!("invalid reference: {name}"))?;
            branch.peel_to_id()?.detach()
        }
        CheckoutTarget::Detached(sha) => repo.rev_parse_single(sha.as_str())?.object()?.peel_to_commit()?.id,
    };
    let target_tree = repo.find_commit(id)?.tree_id()?.detach();
    let changes = tree_changes(repo, head_tree(repo)?, target_tree)?;
    refuse_losses(repo, root, &changes)?;
    write_worktree(repo, root, &changes)?;
    write_index(repo, root, target_tree, &changes)?;
    move_head(repo, target, id)
}

/// Git's refusals, checked for every path the switch would write before any is written: a local
/// change to a path it rewrites, or an untracked file, not ignored, where it puts one.
fn refuse_losses(repo: &gix::Repository, root: &Path, changes: &[PathChange]) -> anyhow::Result<()> {
    let (dirty, _) = worktree_changes(repo, root, head_tree(repo)?)?;
    let dirty: std::collections::HashSet<BString> =
        dirty.into_iter().filter(|c| !is_submodule(c)).filter_map(|(o, n)| o.or(n)).map(|i| i.path).collect();
    let local: Vec<_> =
        changes.iter().filter_map(|(o, n)| o.as_ref().or(n.as_ref())).filter(|i| dirty.contains(&i.path)).collect();
    if let Some(item) = local.first() {
        bail!("Your local changes to the following files would be overwritten by checkout: {}", item.path);
    }
    let index = repo.index_or_empty()?;
    let mut excludes =
        repo.excludes(&index, None, gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped)?;
    let tracked = |path: &[u8]| index.entry_by_path(path.as_bstr()).is_some();
    for new in changes.iter().filter_map(|(_, n)| n.as_ref()).filter(|n| kind(n.mode) != GITLINK) {
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
                    bail!(
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

/// Removes what the target lacks, then writes what it adds or changes, through the smudge filters.
fn write_worktree(repo: &gix::Repository, root: &Path, changes: &[PathChange]) -> anyhow::Result<()> {
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
        write_file(repo, &mut pipeline, new, &abs)?;
    }
    Ok(())
}

fn write_file(
    repo: &gix::Repository,
    pipeline: &mut gix::filter::Pipeline<'_>,
    item: &Item,
    abs: &Path,
) -> anyhow::Result<()> {
    use gix::filter::plumbing::driver::apply::MaybeDelayed;
    use gix::filter::plumbing::pipeline::convert::ToWorktreeOutcome;
    let blob = repo.find_object(item.id)?.detach().data;
    if item.mode == SYMLINK {
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
        ToWorktreeOutcome::Process(MaybeDelayed::Delayed(_)) => bail!("a delayed filter cannot write {}", item.path),
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

/// The index of the target tree, keeping the stat data of paths the switch did not touch so the
/// next status need not re-read them.
fn write_index(repo: &gix::Repository, root: &Path, tree: ObjectId, changes: &[PathChange]) -> anyhow::Result<()> {
    let old = repo.index_or_empty()?;
    let mut index = repo.index_from_tree(&tree)?;
    let written: std::collections::HashSet<&[u8]> =
        changes.iter().filter_map(|(_, n)| n.as_ref()).map(|n| n.path.as_slice()).collect();
    for (entry, path) in index.entries_mut_with_paths() {
        if written.contains(path.as_bytes()) {
            let abs = root.join(native(path)?);
            if let Ok(meta) = gix::index::fs::Metadata::from_path_no_follow(&abs) {
                entry.stat = Stat::from_fs(&meta)?;
            }
        } else if let Some(previous) = old.entry_by_path(path).filter(|e| e.id == entry.id && e.mode == entry.mode) {
            entry.stat = previous.stat;
        }
    }
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
