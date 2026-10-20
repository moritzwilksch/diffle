//! Ports of the snapshot helpers in `protocol.ts`.
use super::{ModeSpec, Side, Snapshot};

/// Names the bytes of one side of `path`, or none when the side has no name: a changed file's
/// blob on that side, else the commit of a side that is one, since an unchanged path is alike on
/// both. What a key names never changes, so an image served under it may be cached for good.
pub fn image_key(snap: &Snapshot, path: &str, side: Side) -> Option<String> {
    if let Some(file) = snap.changed.iter().find(|f| f.path == path) {
        let blob = if side == Side::New { &file.blob } else { &file.old_blob };
        return (!blob.is_empty()).then(|| blob.clone());
    }
    [&snap.new_sha, &snap.old_sha].into_iter().find(|rev| *rev != "worktree").cloned()
}

/// Whether the new side is what is checked out: the worktree, or HEAD's commit.
pub fn follows_checkout(snap: &Snapshot) -> bool {
    snap.new_sha == "worktree" || (!snap.head_sha.is_empty() && snap.new_sha == snap.head_sha)
}

/// The iteration numbers an interdiff of two recorded iterations compares, if it is one.
pub fn shown_iterations(mode: &ModeSpec) -> Option<(i64, i64)> {
    let inter = mode.interdiff.as_ref()?;
    Some((inter.from.iteration?, inter.to.iteration?))
}
