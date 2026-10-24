//! The worktree as git sees it through the index: tracked paths, cleared by the stat cache where
//! unchanged, and untracked files.
use std::path::{Path, PathBuf};

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::index::entry::{Flags, Mode, Stage, Stat};

use super::sides::{EXECUTABLE, FILE, GITLINK, Item, SYMLINK, empty_blob, hash_path, kind, native, submodule_head};

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
    let probe = Probe {
        index: &index,
        root,
        executable_bit: repo.filesystem_options()?.executable_bit,
        stat_options: repo.stat_options()?,
    };
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
                if let Some(id) = hash_path(repo, pipeline, filter_index, &item.path, &abs, item.mode) {
                    item.id = id;
                    items.push(item);
                }
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
    executable_bit: bool,
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
        item.mode = if meta.is_symlink() {
            SYMLINK
        } else if !self.executable_bit {
            if entry.mode == Mode::FILE_EXECUTABLE { EXECUTABLE } else { FILE }
        } else if meta.is_executable() {
            EXECUTABLE
        } else {
            FILE
        };
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

/// Untracked files as worktree items; their contents are hashed, never kept.
pub fn untracked_items(repo: &gix::Repository, root: &Path, paths: &[String]) -> anyhow::Result<Vec<Item>> {
    let (mut pipeline, index) = repo.filter_pipeline(None)?;
    let caps = repo.filesystem_options()?;
    Ok(paths
        .iter()
        .filter_map(|path| {
            let abs = root.join(path);
            let meta = std::fs::symlink_metadata(&abs).ok()?;
            let mode = if meta.is_symlink() {
                SYMLINK
            } else if caps.executable_bit && is_executable(&meta) {
                EXECUTABLE
            } else {
                FILE
            };
            let path = BString::from(path.as_str());
            // Unreadable (permissions) counts as empty: one bad path must not fail the snapshot.
            let id = hash_path(repo, &mut pipeline, &index, &path, &abs, mode).unwrap_or_else(|| empty_blob(repo));
            Some(Item { path, mode, id, worktree: true, size: Some(meta.len()), untracked: true })
        })
        .collect())
}

/// The worktree's side of one path whose blob `id` is already known: its mode as git would record it.
pub fn worktree_item(root: &Path, path: &str, id: ObjectId, index: &gix::index::State, executable_bit: bool) -> Item {
    let staged = index.entry_by_path(path.as_bytes().as_bstr()).map(|e| e.mode);
    let meta = std::fs::symlink_metadata(root.join(path)).ok();
    let mode = match (&meta, staged) {
        (_, Some(mode)) if mode.is_submodule() => GITLINK,
        (Some(meta), _) if meta.is_symlink() => SYMLINK,
        (Some(meta), _) if executable_bit => {
            if is_executable(meta) {
                EXECUTABLE
            } else {
                FILE
            }
        }
        (_, Some(Mode::FILE_EXECUTABLE)) => EXECUTABLE,
        _ => FILE,
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
