//! Each side of a comparison as git sees it: a tree's entries, or the worktree through the index,
//! whose stat cache spares re-reading files that have not changed since they were staged.
use std::borrow::Cow;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use gix::ObjectId;
use gix::bstr::{BString, ByteSlice};
use gix::diff::Rewrites;
use gix::diff::blob::pipeline::{Mode, WorktreeRoots};
use gix::diff::blob::{Platform, ResourceKind};
use gix::diff::rewrites::Tracker;
use gix::diff::rewrites::tracker::ChangeKind;
use gix::filter::plumbing::pipeline::convert::ToGitOutcome;
use gix::index::entry::{Flags, Stage};
use gix::objs::tree::{EntryKind, EntryMode};

use crate::error::GitError;

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

/// One side's bytes as diffed; none where binary or unreadable.
pub type Content<'a> = Option<Cow<'a, [u8]>>;

/// Reads both sides of a comparison as git diffs them, through gix's diff pipeline: blobs from
/// the object database, worktree files through their clean filters. A binary side (a `-diff`
/// attribute, a NUL early on, past `core.bigFileThreshold`) or an unreadable one reads as none.
pub struct Contents<'repo> {
    repo: &'repo gix::Repository,
    /// Each side where it lives: the worktree's from disk. Rename tracking reads through it too.
    pub sides: Platform,
    /// Blobs the object database holds, on either side: a clean or sparse worktree path's included.
    blobs: Platform,
    symlinks: bool,
}

impl<'repo> Contents<'repo> {
    /// `live` names the side that is the worktree at `root`, if one is.
    pub fn new(repo: &'repo gix::Repository, root: &Path, live: Option<ResourceKind>) -> anyhow::Result<Self> {
        let at = |kind| (live == Some(kind)).then(|| root.to_owned());
        let roots =
            WorktreeRoots { old_root: at(ResourceKind::OldOrSource), new_root: at(ResourceKind::NewOrDestination) };
        Ok(Self {
            repo,
            sides: repo.diff_resource_cache(Mode::ToGit, roots)?,
            blobs: repo.diff_resource_cache_for_tree_diff()?,
            symlinks: repo.filesystem_options()?.symlink,
        })
    }

    /// Both sides of a pair, an absent one empty; a gitlink reads as its `Subproject commit` line.
    pub fn pair(&mut self, old: Option<&Item>, new: Option<&Item>) -> (Content<'_>, Content<'_>) {
        self.sides.clear_resource_cache_keep_allocation();
        self.blobs.clear_resource_cache_keep_allocation();
        let set = (self.set(old, ResourceKind::OldOrSource), self.set(new, ResourceKind::NewOrDestination));
        (self.get(old, ResourceKind::OldOrSource, set.0), self.get(new, ResourceKind::NewOrDestination, set.1))
    }

    fn set(&mut self, item: Option<&Item>, side: ResourceKind) -> bool {
        let Some(item) = item.filter(|i| kind(i.mode) != GITLINK) else { return true };
        let mode = match item.mode {
            // A link checked out as a plain file (`core.symlinks=false`) holds its target.
            SYMLINK if !(item.worktree && !self.symlinks) => EntryKind::Link,
            EXECUTABLE => EntryKind::BlobExecutable,
            _ => EntryKind::Blob,
        };
        let platform = if item.worktree { &mut self.sides } else { &mut self.blobs };
        platform.set_resource(item.id, mode, item.path.as_bstr(), side, &self.repo.objects).is_ok()
    }

    fn get(&self, item: Option<&Item>, side: ResourceKind, set: bool) -> Content<'_> {
        let Some(item) = item else { return Some(Cow::Borrowed(&[])) };
        if kind(item.mode) == GITLINK {
            return Some(Cow::Owned(format!("Subproject commit {}\n", item.id).into_bytes()));
        }
        let platform = if item.worktree { &self.sides } else { &self.blobs };
        set.then(|| platform.resource(side)?.data.as_slice().map(Cow::Borrowed)).flatten()
    }

    /// Folds deletions and additions gix's rename tracker pairs into renames: `pairs` lists each
    /// candidate's item, side and its caller's index, and the pairs come back as those indices.
    pub fn renames(&mut self, candidates: Vec<(Item, ResourceKind, usize)>) -> anyhow::Result<Vec<(usize, usize)>> {
        let rewrites = Rewrites { copies: None, percentage: Some(0.5), limit: 1000, track_empty: false };
        let mut tracker = Tracker::new(rewrites);
        for (item, side, index) in candidates {
            let path = item.path.clone();
            tracker.try_push_change(Candidate { item, side, index }, path.as_bstr());
        }
        let mut found = Vec::new();
        tracker.emit(
            |dst, src| {
                if let Some(src) = src {
                    found.push((src.change.index, dst.change.index));
                }
                std::ops::ControlFlow::Continue(())
            },
            &mut self.sides,
            &self.repo.objects,
            |_| Ok::<_, std::io::Error>(()),
        )?;
        Ok(found)
    }
}

/// A deletion or addition the rename tracker may pair.
#[derive(Clone)]
pub struct Candidate {
    item: Item,
    side: ResourceKind,
    index: usize,
}

impl gix::diff::rewrites::tracker::Change for Candidate {
    fn id(&self) -> &gix::oid {
        &self.item.id
    }

    fn relation(&self) -> Option<gix::diff::tree::visit::Relation> {
        None
    }

    fn kind(&self) -> ChangeKind {
        match self.side {
            ResourceKind::OldOrSource => ChangeKind::Deletion,
            ResourceKind::NewOrDestination => ChangeKind::Addition,
        }
    }

    fn entry_mode(&self) -> EntryMode {
        EntryMode::try_from(self.item.mode).unwrap_or(EntryKind::Blob.into())
    }

    fn id_and_entry_mode(&self) -> (&gix::oid, EntryMode) {
        (self.id(), self.entry_mode())
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
