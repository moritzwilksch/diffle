//! Reading a snapshot's sides through its allowlist, and placing comments against what it shows.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::{Active, Session};
use crate::comments::anchor::quote_range;
use crate::comments::hunks::shown_ranges;
use crate::comments::{AnchorSource, ReviewView, SideView};
use crate::error::Result;
use crate::git::WORKTREE;
use crate::protocol::{Side, Snapshot, image_key};
use crate::snapshotter::Snapshotter;

/// The paths a snapshot exposes, for answering reads without touching Git.
pub struct ReadablePaths {
    /// Every path on the new side.
    tree: HashSet<String>,
    /// Changed files by new path, with the old path of a rename or copy.
    changed: HashMap<String, Option<String>>,
    /// Old paths of renames and copies.
    old_paths: HashSet<String>,
}

impl ReadablePaths {
    pub fn of(snap: &Snapshot) -> Self {
        let changed = snap.changed.iter().map(|f| (f.path.clone(), f.old_path.clone())).collect();
        let old_paths = snap.changed.iter().filter_map(|f| f.old_path.clone()).collect();
        Self { tree: snap.tree.iter().cloned().collect(), changed, old_paths }
    }
}

/// The path to read on `side` for a snapshot path, or none when the snapshot does not expose it.
/// New side: tree paths only. Old side: a changed file's old path (renames map new → old), plus
/// tree paths and rename sources.
pub fn side_path<'a>(r: &'a ReadablePaths, path: &'a str, side: Side) -> Option<&'a str> {
    if side == Side::New {
        return r.tree.contains(path).then_some(path);
    }
    if let Some(old) = r.changed.get(path) {
        return Some(old.as_deref().unwrap_or(path));
    }
    (r.tree.contains(path) || r.old_paths.contains(path)).then_some(path)
}

impl Session {
    fn readable_paths(&self, snap: &Arc<Snapshot>) -> Arc<ReadablePaths> {
        let mut cache = self.readable.lock().unwrap();
        if let Some((cached, paths)) = cache.as_ref()
            && Arc::ptr_eq(cached, snap)
        {
            return paths.clone();
        }
        let paths = Arc::new(ReadablePaths::of(snap));
        *cache = Some((snap.clone(), paths.clone()));
        paths
    }

    /// Reads a file on one side of a snapshot. `path` is a snapshot path, i.e. a changed file's new
    /// path or any tree path; the old side of a rename is resolved to its old path here. Anything
    /// outside the snapshot (ignored files, `.git`, traversal) reads as absent.
    pub async fn read_side(&self, snap: &Arc<Snapshot>, path: &str, side: Side) -> Result<Option<Vec<u8>>> {
        let paths = self.readable_paths(snap);
        let Some(target) = side_path(&paths, path, side) else { return Ok(None) };
        let rev = if side == Side::New { &snap.new_sha } else { &snap.old_sha };
        if rev == WORKTREE {
            Ok(self.repo.read_worktree(target).await?)
        } else {
            Ok(self.repo.show(rev, target).await?)
        }
    }

    /// The bytes `key` names on one side of `path`, or none unless `key` is that side's `image_key`
    /// in `snap`. A worktree file that changed since `snap` reads as none too, so a key never serves
    /// other bytes.
    pub async fn read_image(&self, snap: &Arc<Snapshot>, path: &str, side: Side, key: &str) -> Result<Option<Vec<u8>>> {
        if image_key(snap, path, side).as_deref() != Some(key) {
            return Ok(None);
        }
        // An unchanged path's key is a commit: read that commit, not a worktree that may have moved on.
        if !snap.changed.iter().any(|f| f.path == path) {
            return self.read_side(snap, path, if key == snap.new_sha { Side::New } else { Side::Old }).await;
        }
        let Some(buf) = self.read_side(snap, path, side).await? else { return Ok(None) };
        if (if side == Side::New { &snap.new_sha } else { &snap.old_sha }) != WORKTREE {
            return Ok(Some(buf));
        }
        // The file may have changed since `snap`: serve it only while it still hashes to the key.
        let paths = self.readable_paths(snap);
        let Some(target) = side_path(&paths, path, side) else { return Ok(None) };
        Ok((self.repo.hash_object(&buf, target).await? == key).then_some(buf))
    }

    /// Whether `read_side` would find `path` on `side`: the allowlist alone, no read.
    pub fn has_side(&self, snap: &Arc<Snapshot>, path: &str, side: Side) -> bool {
        side_path(&self.readable_paths(snap), path, side).is_some()
    }

    /// Whether `path` is a file of the review: a changed file (by its new path) or a tree path. A
    /// rename's old path is not.
    pub fn has_file(&self, snap: &Arc<Snapshot>, path: &str) -> bool {
        let r = self.readable_paths(snap);
        r.tree.contains(path) || r.changed.contains_key(path)
    }

    /// Places imported anchors against the current snapshot, through `read_side`, so the allowlist
    /// applies. Comments are off in an interdiff: its old side is a replayed tree, and its threads
    /// would live under a key the range never shows.
    pub fn anchor_source(self: &Arc<Self>) -> Result<impl AnchorSource + use<>> {
        let a = self.active()?;
        if let Some(off) = super::comments_off(&a.review) {
            return Err(off);
        }
        Ok(Placer { session: self.clone(), snapshotter: a.snapshotter.clone() })
    }

    /// Re-anchors threads against what `snap` shows. A changed file shows its hunks; an unchanged
    /// tree file shows its new side whole (the file view) and nothing of its old side. A file thread
    /// only needs its file in the review.
    pub(super) async fn relocate_comments(self: &Arc<Self>, a: &Active, snap: &Arc<Snapshot>) -> Result<()> {
        let view = Review { session: self, snapshotter: &a.snapshotter, snap };
        a.comments.relocate_all(&view).await.map(drop)
    }
}

struct Placer {
    session: Arc<Session>,
    snapshotter: Arc<Snapshotter>,
}

impl AnchorSource for Placer {
    async fn quote(&self, path: &str, side: Side, start: i64, end: i64) -> Result<Option<String>> {
        let snap = self.snapshotter.current().await?;
        let buf = self.session.read_side(&snap, path, side).await?;
        Ok(buf.and_then(|b| quote_range(&String::from_utf8_lossy(&b), start, end)))
    }

    async fn has_file(&self, path: &str) -> Result<bool> {
        Ok(self.session.has_file(&self.snapshotter.current().await?, path))
    }
}

struct Review<'a> {
    session: &'a Arc<Session>,
    snapshotter: &'a Arc<Snapshotter>,
    snap: &'a Arc<Snapshot>,
}

impl ReviewView for Review<'_> {
    async fn side(&self, path: &str, side: Side) -> Result<Option<SideView>> {
        let Some(buf) = self.session.read_side(self.snap, path, side).await? else { return Ok(None) };
        let contents = String::from_utf8_lossy(&buf).into_owned();
        if !self.snap.changed.iter().any(|f| f.path == path) {
            return Ok((side == Side::New).then_some(SideView { contents, shown: None }));
        }
        let patch = self.snapshotter.patch(path).await?.unwrap_or_default();
        Ok(Some(SideView { contents, shown: Some(shown_ranges(&patch, side)) }))
    }

    fn has_file(&self, path: &str) -> bool {
        self.session.has_file(self.snap, path)
    }
}
