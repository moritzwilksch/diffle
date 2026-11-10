//! Each side of a comparison as git sees it: a tree's entries, or the worktree through the index,
//! whose stat cache spares re-reading files that have not changed since they were staged.
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::filter::plumbing::pipeline::convert::ToGitOutcome;
use gix::index::entry::{Flags, Stage};

use crate::error::GitError;
use crate::git::BIG_FILE_THRESHOLD;

pub const FILE: u32 = 0o100644;
pub const EXECUTABLE: u32 = 0o100755;
pub const SYMLINK: u32 = 0o120000;
pub const GITLINK: u32 = 0o160000;

/// One path on one side.
#[derive(Clone, Debug)]
pub struct Item {
    pub path: BString,
    pub mode: u32,
    pub id: ObjectId,
    /// Read from the worktree rather than the object database.
    pub worktree: bool,
    /// In the worktree but not the index.
    pub untracked: bool,
}

/// What a path holds, as git's file-type bits tell it: a typechange is a change between these.
pub fn kind(mode: u32) -> u32 {
    mode & 0o170000
}

/// Every entry of `tree`, sorted by path. Read off the index when its cache-tree records that
/// very tree, as it does after a commit or checkout, which spares reading the tree objects.
pub fn tree_items(repo: &gix::Repository, tree: ObjectId) -> anyhow::Result<Vec<Item>> {
    let index = repo.index_or_empty()?;
    // A sparse index's directory entries stand for files it does not list.
    let recorded = !index.is_sparse() && index.tree().is_some_and(|root| root.id == tree && root.num_entries.is_some());
    if recorded
        && index.entries().iter().all(|e| e.stage() == Stage::Unconflicted && !e.flags.contains(Flags::INTENT_TO_ADD))
    {
        return Ok(index.entries().iter().map(|e| item(e.path(&index), e.mode.bits(), e.id)).collect());
    }
    from_tree(repo, tree)
}

/// The index, every tracked path listed. A sparse index collapses whole directories into one
/// entry, which gix does not expand, so it is refused rather than misread.
pub(super) fn full_index(repo: &gix::Repository) -> anyhow::Result<gix::worktree::Index> {
    let index = repo.index_or_empty()?;
    if index.is_sparse() {
        return Err(GitError::new(
            "a sparse index is not supported; expand it with `git sparse-checkout reapply --no-sparse-index`",
        )
        .into());
    }
    Ok(index)
}

pub(super) fn item(path: &gix::bstr::BStr, mode: u32, id: ObjectId) -> Item {
    Item { path: path.to_owned(), mode, id, worktree: false, untracked: false }
}

/// Every entry of `tree`, sorted by path.
fn from_tree(repo: &gix::Repository, tree: ObjectId) -> anyhow::Result<Vec<Item>> {
    let index = repo.index_from_tree(&tree)?;
    Ok(index.entries().iter().map(|e| item(e.path(&index), e.mode.bits(), e.id)).collect())
}

/// The paths whose entries differ between two trees, sorted, each with its side in either tree.
/// Subtrees the two share are skipped unread, as git's tree diff skips them.
pub fn tree_diff(
    repo: &gix::Repository,
    old: ObjectId,
    new: ObjectId,
) -> anyhow::Result<Vec<(Option<Item>, Option<Item>)>> {
    use gix::diff::tree::recorder::Change;
    let (old, new) = (repo.find_tree(old)?, repo.find_tree(new)?);
    let hash = repo.object_hash();
    let mut recorder = gix::diff::tree::Recorder::default();
    gix::diff::tree(
        gix::objs::TreeRefIter::from_bytes(&old.data, hash),
        gix::objs::TreeRefIter::from_bytes(&new.data, hash),
        &mut gix::diff::tree::State::default(),
        &repo.objects,
        &mut recorder,
    )?;
    // Trees themselves are not paths a diff lists; a file that became a directory is two changes.
    let side = |path: &BString, mode: gix::objs::tree::EntryMode, id| {
        (!mode.is_tree()).then(|| item(path.as_bstr(), u32::from(mode.value()), id))
    };
    let mut changes: Vec<_> = recorder
        .records
        .into_iter()
        .flat_map(|change| match change {
            Change::Addition { entry_mode, oid, path, .. } => vec![(None, side(&path, entry_mode, oid))],
            Change::Deletion { entry_mode, oid, path, .. } => vec![(side(&path, entry_mode, oid), None)],
            Change::Modification { previous_entry_mode, previous_oid, entry_mode, oid, path } => {
                match (side(&path, previous_entry_mode, previous_oid), side(&path, entry_mode, oid)) {
                    (Some(o), Some(n)) => vec![(Some(o), Some(n))],
                    (o, n) => vec![(o, None), (None, n)],
                }
            }
        })
        .filter(|(o, n)| o.is_some() || n.is_some())
        .collect();
    changes.sort_by(|(ao, an), (bo, bn)| {
        let path = |o: &Option<Item>, n: &Option<Item>| n.as_ref().or(o.as_ref()).map(|i| i.path.clone());
        path(ao, an).cmp(&path(bo, bn))
    });
    Ok(changes)
}

/// Reads sides' contents: blobs from the object database, worktree files through their clean filters.
pub struct Reader<'repo> {
    repo: &'repo gix::Repository,
    root: PathBuf,
    pipeline: gix::filter::Pipeline<'repo>,
    index: gix::worktree::IndexPersistedOrInMemory,
}

impl<'repo> Reader<'repo> {
    pub fn new(repo: &'repo gix::Repository, root: &Path) -> anyhow::Result<Self> {
        let (pipeline, index) = repo.filter_pipeline(None)?;
        Ok(Self { repo, root: root.to_owned(), pipeline, index })
    }

    /// What git diffs for `item`: a gitlink reads as its `Subproject commit` line. None when it is
    /// past the big-file threshold, which git diffs as binary unread, or cannot be read.
    pub fn content(&mut self, item: &Item) -> Option<Vec<u8>> {
        if kind(item.mode) == GITLINK {
            return Some(format!("Subproject commit {}\n", item.id).into_bytes());
        }
        // Bytes git already stores (a staged, unchanged file) come from the object database, sized
        // by their header first so a big blob is never inflated.
        if let Ok(Some(header)) = self.repo.try_find_header(item.id) {
            if header.size() >= BIG_FILE_THRESHOLD {
                return None;
            }
            return self.repo.find_object(item.id).ok().map(|object| object.detach().data);
        }
        if !item.worktree {
            return None;
        }
        let abs = self.root.join(native(item.path.as_bstr())?);
        let meta = std::fs::symlink_metadata(&abs).ok()?;
        if meta.is_symlink() {
            let target = std::fs::read_link(&abs).ok()?;
            return Some(gix::path::into_bstr(target).ok()?.into_owned().into());
        }
        if meta.len() >= BIG_FILE_THRESHOLD {
            return None;
        }
        let file = std::fs::File::open(&abs).ok()?;
        to_git(&mut self.pipeline, &self.index, &item.path, file).ok()
    }
}

/// The blob git would store for the worktree file at `abs`; none when it cannot be read. A
/// symlink's blob is its target; a link checked out as a plain file (`core.symlinks=false`) holds it.
pub(super) fn hash_path(
    repo: &gix::Repository,
    pipeline: &mut gix::filter::Pipeline<'_>,
    index: &gix::index::State,
    path: &BString,
    abs: &Path,
) -> Option<ObjectId> {
    if std::fs::symlink_metadata(abs).ok()?.is_symlink() {
        let target = std::fs::read_link(abs).ok()?;
        return blob_id(repo, &gix::path::into_bstr(target).ok()?).ok();
    }
    let file = std::fs::File::open(abs).ok()?;
    let len = file.metadata().ok()?.len();
    hash_to_git(repo, pipeline, index, path, file, len).ok()
}

/// The blob git stores for `src` (`len` bytes) at `path`: line endings, `ident`, encodings and
/// filter drivers applied. Unfiltered content streams through the hasher, so a large file is never held.
pub fn hash_to_git(
    repo: &gix::Repository,
    pipeline: &mut gix::filter::Pipeline<'_>,
    index: &gix::index::State,
    path: &BString,
    src: impl Read,
    len: u64,
) -> anyhow::Result<ObjectId> {
    Ok(match pipeline.convert_to_git(src, &gix::path::from_bstr(path.as_bstr())?, index)? {
        ToGitOutcome::Unchanged(mut src) => {
            let interrupt = AtomicBool::new(false);
            let (kind, progress) = (repo.object_hash(), &mut gix::progress::Discard);
            gix::objs::compute_stream_hash(kind, gix::objs::Kind::Blob, &mut src, len, progress, &interrupt)?
        }
        ToGitOutcome::Process(mut src) => {
            let mut buf = Vec::new();
            src.read_to_end(&mut buf)?;
            blob_id(repo, &buf)?
        }
        ToGitOutcome::Buffer(converted) => blob_id(repo, converted)?,
    })
}

/// `src` as git stores it at `path`.
fn to_git(
    pipeline: &mut gix::filter::Pipeline<'_>,
    index: &gix::index::State,
    path: &BString,
    src: impl Read,
) -> anyhow::Result<Vec<u8>> {
    let mut buf = Vec::new();
    match pipeline.convert_to_git(src, &gix::path::from_bstr(path.as_bstr())?, index)? {
        ToGitOutcome::Unchanged(mut src) => src.read_to_end(&mut buf)?,
        ToGitOutcome::Process(mut src) => src.read_to_end(&mut buf)?,
        ToGitOutcome::Buffer(converted) => {
            buf.extend_from_slice(converted);
            converted.len()
        }
    };
    Ok(buf)
}

pub fn blob_id(repo: &gix::Repository, content: &[u8]) -> gix::Result<ObjectId> {
    gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Blob, content)
}

/// A repository path as the platform spells it.
pub(super) fn native(path: &gix::bstr::BStr) -> Option<PathBuf> {
    gix::path::from_bstr(path).ok().map(std::borrow::Cow::into_owned)
}

/// The commit a checked-out submodule is at; none when it is not a repository of its own.
pub fn submodule_head(dir: &Path) -> Option<ObjectId> {
    Some(gix::open(dir).ok()?.head_id().ok()?.detach())
}
