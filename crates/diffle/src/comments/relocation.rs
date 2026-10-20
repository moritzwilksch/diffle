//! Re-anchoring threads as the reviewed files change.
use std::collections::HashMap;
use std::future::Future;

use super::anchor::relocate;
use super::hunks::is_shown;
use super::store::{CommentStore, read_store_file, write_store_file};
use crate::error::{Error, Result};
use crate::persist::with_file_lock;
use crate::protocol::{CommentAnchor, CommentThread, Side};

/// One side of a file as the review presents it.
pub struct SideView {
    pub contents: String,
    /// Line ranges on display (a diff's hunks); none when the whole side is shown.
    pub shown: Option<Vec<(i64, i64)>>,
}

/// The review as relocation sees it.
pub trait ReviewView: Sync {
    /// One side of a path; none when the review has no such side.
    fn side(&self, path: &str, side: Side) -> impl Future<Output = Result<Option<SideView>>> + Send;
    /// Whether the review has a file at `path` on either side, which is all a file thread needs.
    fn has_file(&self, path: &str) -> bool;
}

impl CommentStore {
    /// Re-anchors every thread against the current review. A line thread is stale when its side is
    /// gone, its text is not found, or the relocated range falls outside what the review shows; a
    /// file thread when its file left the review. Returns whether anything changed.
    pub async fn relocate_all(&self, review: &impl ReviewView) -> Result<bool> {
        // Under the lock: a thread added or moved by another store meanwhile is re-anchored too, never clobbered.
        with_file_lock(&self.file, || async {
            let mut all = read_store_file(&self.file).await?;
            let mut set = all.sets.remove(&self.key).unwrap_or_default();
            let mut sides: HashMap<(Side, String), Option<SideView>> = HashMap::new();
            let mut changed = false;
            for t in &mut set.threads {
                changed |= match &t.anchor {
                    CommentAnchor::File { path } => {
                        let stale = !review.has_file(path);
                        std::mem::replace(&mut t.stale, stale) != stale
                    }
                    CommentAnchor::Line { path, side, .. } => {
                        let key = (*side, path.clone());
                        if !sides.contains_key(&key) {
                            match review.side(path, *side).await {
                                Ok(view) => sides.insert(key.clone(), view),
                                Err(e) => return Ok(Err(e)),
                            };
                        }
                        relocate_thread(t, sides[&key].as_ref())
                    }
                };
            }
            if changed {
                all.sets.insert(self.key.clone(), set);
                write_store_file(&self.file, &all).await?;
            }
            Ok(Ok::<_, Error>(changed))
        })
        .await?
    }
}

/// Moves a line thread onto its text in `view`, or marks it stale. Returns whether it changed.
fn relocate_thread(t: &mut CommentThread, view: Option<&SideView>) -> bool {
    let CommentAnchor::Line { start_line, end_line, quoted, .. } = &mut t.anchor else { return false };
    let moved = view
        .and_then(|v| relocate(*start_line, *end_line, quoted, &v.contents).map(|range| (range, v)))
        .filter(|((s, e), v)| v.shown.as_ref().is_none_or(|shown| is_shown(shown, *s, *e)))
        .map(|(range, _)| range);
    let Some((start, end)) = moved else {
        if t.stale {
            return false;
        }
        t.stale = true;
        t.stale_from_line = Some(*start_line);
        return true;
    };
    let mut changed = false;
    if t.stale {
        t.stale = false;
        t.stale_from_line = None;
        changed = true;
    }
    if (start, end) != (*start_line, *end_line) {
        (*start_line, *end_line) = (start, end);
        changed = true;
    }
    changed
}
