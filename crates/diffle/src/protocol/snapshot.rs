//! Helpers over a snapshot and a review that the client shares.
use super::{RangeRef, RangeView, Review, Side, Snapshot};

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

/// The two iterations an interdiff view compares, if it compares recorded iterations.
pub fn shown_iterations(review: &Review) -> Option<(i64, i64)> {
    let Review::Range { view: RangeView::Interdiff { from, to, .. }, .. } = review else { return None };
    match (from, to) {
        (RangeRef::Iteration { n: from }, Some(RangeRef::Iteration { n: to })) => {
            Some((from.get() as i64, to.get() as i64))
        }
        _ => None,
    }
}

/// The range the review sits in, shown whole, or none for a lone commit.
pub fn range_of(review: &Review) -> Option<Review> {
    match review {
        Review::Range { old, new, base, pr, .. } => Some(Review::Range {
            old: old.clone(),
            new: new.clone(),
            base: *base,
            pr: pr.clone(),
            view: RangeView::Whole,
        }),
        Review::Commit { .. } => None,
    }
}

/// The range's slice, with `view` in place of the shown one; a lone commit has no slices.
pub fn with_view(review: &Review, view: RangeView) -> Option<Review> {
    let mut range = range_of(review)?;
    if let Review::Range { view: slot, .. } = &mut range {
        *slot = view;
    }
    Some(range)
}

/// Whether two reviews name the same thing, slice included.
pub fn same_review(a: &Review, b: &Review) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}
