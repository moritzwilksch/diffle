//! The worktree as git sees it through the index: tracked paths, cleared by the stat cache where
//! unchanged, and untracked files.
use std::path::{Path, PathBuf};

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stage, Stat};

use crate::git::BIG_FILE_THRESHOLD;

use super::sides::{EXECUTABLE, FILE, GITLINK, Item, SYMLINK, hash_path, kind, native, submodule_head};

/// Paths to stat before the stat pass is split across threads.
const PARALLEL_FROM: usize = 2048;
const MAX_THREADS: usize = 8;
/// The worktree's tracked paths, sorted, each as git would store it now; a path that is gone (or
/// became a directory) is absent. The second list names the paths with unresolved conflicts.
pub fn worktree_items(repo: &gix::Repository, root: &Path) -> anyhow::Result<(Vec<Item>, Vec<BString>)> {
    let index = repo.index_or_empty()?;
    let entries = index.entries();
    // One slot per path: its stage-0 entry, or for a conflict its last stage.
    let (mut slots, mut conflicts) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < entries.len() {
        let path = entries[i].path(&index);
        let next = i + entries[i..].iter().take_while(|e| e.path(&index) == path).count();
        match entries[i..next].iter().position(|e| e.stage() == Stage::Unconflicted) {
            Some(at) => slots.push((i + at, true)),
            None => {
                conflicts.push(path.to_owned());
                slots.push((next - 1, false));
            }
        }
        i = next;
    }
    let probe = Probe { index: &index, root, caps: repo.filesystem_options()?, stat_options: repo.stat_options()? };
    let probed = parallel_map(&slots, |&(i, staged)| probe.entry(&entries[i], staged));
    // Only files the stat cache could not clear are read and hashed.
    let mut hashing: Option<(gix::filter::Pipeline<'_>, gix::worktree::IndexPersistedOrInMemory)> = None;
    let mut items = Vec::with_capacity(probed.len());
    for state in probed {
        match state {
            State::Known(item) => items.push(item),
            State::Gone => {}
            State::Dirty(mut item, abs) => {
                let (pipeline, filter_index) = match &mut hashing {
                    Some(hashing) => hashing,
                    None => hashing.insert(repo.filter_pipeline(None)?),
                };
                // Unreadable (permissions) gets the null id, an empty blob to callers: one bad path
                // must not fail the snapshot, nor read as deleted.
                item.id = hash_path(repo, pipeline, filter_index, &item.path, &abs)
                    .unwrap_or_else(|| ObjectId::null(repo.object_hash()));
                items.push(item);
            }
        }
    }
    Ok((items, conflicts))
}

/// What the stat cache says about one tracked path.
enum State {
    /// Its blob is known: unchanged since staged, skipped by sparse checkout, or a submodule.
    Known(Item),
    /// Gone from the worktree, or a directory now.
    Gone,
    /// Changed, or not provably unchanged: its content must be hashed.
    Dirty(Item, PathBuf),
}

struct Probe<'a> {
    index: &'a gix::index::State,
    root: &'a Path,
    caps: gix::fs::Capabilities,
    stat_options: gix::index::entry::stat::Options,
}

impl Probe<'_> {
    fn entry(&self, entry: &gix::index::Entry, staged: bool) -> State {
        let path = entry.path(self.index);
        let mut item = Item {
            path: path.to_owned(),
            mode: entry.mode.bits(),
            id: entry.id,
            worktree: false,
            size: None,
            untracked: false,
        };
        if entry.mode.is_sparse() || entry.flags.contains(Flags::SKIP_WORKTREE) {
            return State::Known(item);
        }
        let Some(abs) = native(path).map(|p| self.root.join(p)) else { return State::Gone };
        if entry.mode.is_submodule() {
            // An unpopulated submodule is unchanged, as git sees it.
            if let Some(head) = submodule_head(&abs) {
                item.id = head;
            }
            return State::Known(item);
        }
        let Ok(meta) = gix::index::fs::Metadata::from_path_no_follow(&abs) else { return State::Gone };
        if meta.is_dir() {
            return State::Gone;
        }
        item.mode = mode_on_disk(meta.is_symlink(), meta.is_executable(), Some(entry.mode), self.caps);
        item.size = Some(meta.len());
        let clean = staged
            && kind(item.mode) == kind(entry.mode.bits())
            && !entry.flags.contains(Flags::INTENT_TO_ADD)
            && Stat::from_fs(&meta).is_ok_and(|stat| entry.stat.matches(&stat, self.stat_options))
            && !entry.stat.is_racy(self.index.timestamp(), self.stat_options);
        if clean {
            return State::Known(item);
        }
        item.worktree = true;
        State::Dirty(item, abs)
    }
}

/// `f` over `items` in order, on a few threads once there are enough items to pay for them.
fn parallel_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism().map_or(1, usize::from).min(MAX_THREADS);
    if threads < 2 || items.len() < PARALLEL_FROM {
        return items.iter().map(f).collect();
    }
    let chunk = items.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> =
            items.chunks(chunk).map(|part| scope.spawn(|| part.iter().map(&f).collect::<Vec<_>>())).collect();
        handles.into_iter().flat_map(|h| h.join().expect("stat worker panicked")).collect()
    })
}

/// Untracked files as worktree items; their contents are hashed, never kept. One past the big-file
/// threshold is not read at all: git diffs it as binary unread, and its blob reads as empty.
pub fn untracked_items(repo: &gix::Repository, root: &Path, paths: &[String]) -> anyhow::Result<Vec<Item>> {
    let (mut pipeline, index) = repo.filter_pipeline(None)?;
    let caps = repo.filesystem_options()?;
    Ok(paths
        .iter()
        .filter_map(|path| {
            let abs = root.join(path);
            let meta = std::fs::symlink_metadata(&abs).ok()?;
            let mode = mode_on_disk(meta.is_symlink(), is_executable(&meta), None, caps);
            let path = BString::from(path.as_str());
            let big = meta.is_file() && meta.len() >= BIG_FILE_THRESHOLD;
            // Unreadable (permissions) counts as empty: one bad path must not fail the snapshot.
            let id = (!big)
                .then(|| hash_path(repo, &mut pipeline, &index, &path, &abs))
                .flatten()
                .unwrap_or_else(|| ObjectId::null(repo.object_hash()));
            Some(Item { path, mode, id, worktree: true, size: Some(meta.len()), untracked: true })
        })
        .collect())
}

/// The mode git records for a worktree file, given what it is on disk and its staged mode. Where
/// the filesystem cannot say (`core.fileMode=false`, `core.symlinks=false`), the staged mode stands.
fn mode_on_disk(symlink: bool, executable: bool, staged: Option<Mode>, caps: gix::fs::Capabilities) -> u32 {
    match staged {
        _ if symlink => SYMLINK,
        Some(Mode::SYMLINK) if !caps.symlink => SYMLINK,
        _ if caps.executable_bit => {
            if executable {
                EXECUTABLE
            } else {
                FILE
            }
        }
        Some(Mode::FILE_EXECUTABLE) => EXECUTABLE,
        _ => FILE,
    }
}

/// The worktree's side of one path whose blob `id` is already known: its mode as git would record it.
pub fn worktree_item(
    root: &Path,
    path: &str,
    id: ObjectId,
    index: &gix::index::State,
    caps: gix::fs::Capabilities,
) -> Item {
    let staged = index.entry_by_path(path.as_bytes().as_bstr()).map(|e| e.mode);
    let meta = std::fs::symlink_metadata(root.join(path)).ok();
    let mode = match (&meta, staged) {
        (_, Some(mode)) if mode.is_submodule() => GITLINK,
        (Some(meta), _) => mode_on_disk(meta.is_symlink(), is_executable(meta), staged, caps),
        (None, Some(mode)) => mode.bits(),
        (None, None) => FILE,
    };
    let size = meta.as_ref().map(std::fs::Metadata::len);
    Item { path: path.into(), mode, id, worktree: true, size, untracked: staged.is_none() }
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    false
}
