//! The switch's writes to disk: the target's files, read and filtered before anything changes.
use std::collections::HashSet;
use std::path::Path;

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::worktree::stack::state::attributes::Source as AttributeSource;

use super::{deleted, native};
use crate::error::GitError;
use crate::git::diff::PathChange;
use crate::git::diff::sides::{EXECUTABLE, GITLINK, Item, SYMLINK, kind};

/// Removes what the target lacks, then writes what it adds or changes, through the smudge filters
/// the target's `.gitattributes` name, as git reads them from the index it checks out; paths
/// sparse checkout skips stay off disk. Every blob is read and filtered before anything on disk
/// changes, so a missing object or a failing filter refuses the switch instead of halting it midway.
pub(super) fn write(
    repo: &gix::Repository,
    root: &Path,
    target_tree: ObjectId,
    changes: &[PathChange],
    skipped: &HashSet<BString>,
) -> anyhow::Result<()> {
    let changes: Vec<_> =
        changes.iter().filter(|(o, n)| !skipped.contains(&n.as_ref().or(o.as_ref()).expect("a side").path)).collect();
    let target_index = repo.index_from_tree(&target_tree)?;
    let attributes = repo.attributes_only(&target_index, AttributeSource::IdMapping)?;
    let mut pipeline = gix::filter::Pipeline::new(repo, attributes.detach())?;
    let symlinks = repo.filesystem_options()?.symlink;
    let written = changes
        .iter()
        .filter_map(|(_, n)| n.as_ref())
        .map(|new| Ok((root.join(native(&new.path)?), render(repo, &mut pipeline, new, symlinks)?)))
        .collect::<anyhow::Result<Vec<_>>>()?;
    for old in deleted(changes.iter().copied()) {
        let abs = root.join(native(&old.path)?);
        // A submodule's checkout is left in place, as git leaves it; an emptied one goes.
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
    // Without symlinks (`core.symlinks=false`) a link is a plain file holding its target, as git
    // writes it; so is one where the platform has none.
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
