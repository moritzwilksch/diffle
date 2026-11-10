//! The worktree as git sees it through the index: gix-status clears tracked paths by the stat
//! cache and hashes the rest; untracked files are hashed here.
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use gix::ObjectId;
use gix::bstr::{BStr, BString, ByteSlice};
use gix::index::entry::{Mode, Stage};
use gix::status::plumbing::index_as_worktree::traits::{CompareBlobs, HashEq, ReadData, SubmoduleStatus};
use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
use gix::status::plumbing::index_as_worktree_with_renames::{Entry, VisitEntry};

use crate::git::BIG_FILE_THRESHOLD;

use super::sides::{EXECUTABLE, FILE, GITLINK, Item, SYMLINK, full_index, hash_path, item, native, submodule_head};

/// The worktree's tracked paths, sorted, each as git would store it now; a path that is gone (or
/// became a directory) is absent. The second list names the paths with unresolved conflicts. A
/// sparse index is refused.
pub fn worktree_items(repo: &gix::Repository, root: &Path) -> anyhow::Result<(Vec<Item>, Vec<BString>)> {
    let index = full_index(repo)?;
    let mut statuses = Statuses::default();
    let submodules = SubmoduleHead { root: root.to_owned() };
    repo.index_worktree_status(
        &index,
        None::<&BStr>,
        &mut statuses,
        Hash,
        submodules,
        &mut gix::progress::Discard,
        &AtomicBool::new(false),
        Default::default(),
    )?;
    let mut probe = Probe { repo, root, caps: repo.filesystem_options()?, hashing: None };
    let entries = index.entries();
    let (mut items, mut conflicts) = (Vec::with_capacity(entries.len()), Vec::new());
    let mut i = 0;
    while i < entries.len() {
        let entry = &entries[i];
        let path = entry.path(&index);
        if entry.stage() != Stage::Unconflicted {
            // A conflict's worktree file is what git diffs; its last stage stands in for the entry.
            let next = i + entries[i..].iter().take_while(|e| e.path(&index) == path).count();
            conflicts.push(path.to_owned());
            items.extend(probe.read(&entries[next - 1], path)?);
            i = next;
            continue;
        }
        let mut tracked = item(path, entry.mode.bits(), entry.id);
        match statuses.0.remove(&i) {
            None | Some(EntryStatus::NeedsUpdate(_)) => items.push(tracked),
            Some(EntryStatus::Change(Change::Removed)) => {}
            Some(EntryStatus::Change(Change::SubmoduleModification(head))) => {
                tracked.id = head;
                items.push(tracked);
            }
            Some(EntryStatus::Change(Change::Modification { executable_bit_changed, content_change, .. })) => {
                if executable_bit_changed {
                    tracked.mode = if tracked.mode == EXECUTABLE { FILE } else { EXECUTABLE };
                }
                tracked.id = content_change.unwrap_or(tracked.id);
                tracked.worktree = true;
                items.push(tracked);
            }
            // A typechange or an intent-to-add entry says nothing of the content: it is read here.
            Some(
                EntryStatus::Change(Change::Type { .. }) | EntryStatus::IntentToAdd | EntryStatus::Conflict { .. },
            ) => {
                items.extend(probe.read(entry, path)?);
            }
        }
        i += 1;
    }
    Ok((items, conflicts))
}

/// The statuses gix-status found, by index entry; entries it does not report are unchanged.
#[derive(Default)]
struct Statuses(HashMap<usize, EntryStatus<ObjectId, ObjectId>>);

impl<'index> VisitEntry<'index> for Statuses {
    type ContentChange = ObjectId;
    type SubmoduleStatus = ObjectId;

    fn visit_entry(&mut self, entry: Entry<'index, ObjectId, ObjectId>) {
        if let Entry::Modification { entry_index, status, .. } = entry {
            self.0.insert(entry_index, status);
        }
    }
}

/// The worktree blob's id when it differs from the staged one. A file that cannot be read
/// (permissions) gets the null id, an empty blob to callers: one bad path must not fail the
/// snapshot, nor read as deleted.
#[derive(Clone)]
struct Hash;

impl CompareBlobs for Hash {
    type Output = ObjectId;

    fn compare_blobs<'a, 'b>(
        &mut self,
        entry: &gix::index::Entry,
        size: u64,
        data: impl ReadData<'a>,
        buf: &mut Vec<u8>,
    ) -> gix::error::Result<Option<ObjectId>> {
        Ok(HashEq.compare_blobs(entry, size, data, buf).unwrap_or_else(|_| Some(ObjectId::null(entry.id.kind()))))
    }
}

/// A checked-out submodule changes when its HEAD moves; an unpopulated one is unchanged, as git sees it.
#[derive(Clone)]
struct SubmoduleHead {
    root: std::path::PathBuf,
}

impl SubmoduleStatus for SubmoduleHead {
    type Output = ObjectId;

    fn status(&mut self, entry: &gix::index::Entry, path: &BStr) -> gix::error::Result<Option<ObjectId>> {
        let head = native(path).and_then(|p| submodule_head(&self.root.join(p)));
        Ok(head.filter(|head| *head != entry.id))
    }
}

/// Reads the worktree side of an entry the stat cache cannot speak for.
struct Probe<'repo> {
    repo: &'repo gix::Repository,
    root: &'repo Path,
    caps: gix::fs::Capabilities,
    hashing: Option<(gix::filter::Pipeline<'repo>, gix::worktree::IndexPersistedOrInMemory)>,
}

impl Probe<'_> {
    /// The worktree's side of `entry`; none when the path is gone or a directory now.
    fn read(&mut self, entry: &gix::index::Entry, path: &BStr) -> anyhow::Result<Option<Item>> {
        let mut found = item(path, entry.mode.bits(), entry.id);
        let Some(abs) = native(path).map(|p| self.root.join(p)) else { return Ok(None) };
        if entry.mode.is_submodule() {
            found.id = submodule_head(&abs).unwrap_or(entry.id);
            return Ok(Some(found));
        }
        let Ok(meta) = std::fs::symlink_metadata(&abs) else { return Ok(None) };
        if meta.is_dir() {
            return Ok(None);
        }
        let (pipeline, index) = match &mut self.hashing {
            Some(hashing) => hashing,
            None => self.hashing.insert(self.repo.filter_pipeline(None)?),
        };
        found.mode = mode_on_disk(meta.is_symlink(), is_executable(&meta), Some(entry.mode), self.caps);
        found.id = hash_path(self.repo, pipeline, index, &found.path, &abs)
            .unwrap_or_else(|| ObjectId::null(self.repo.object_hash()));
        found.worktree = true;
        Ok(Some(found))
    }
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
            Some(Item { path, mode, id, worktree: true, untracked: true })
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
    Item { path: path.into(), mode, id, worktree: true, untracked: staged.is_none() }
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
