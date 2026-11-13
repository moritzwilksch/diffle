//! Tours: an agent's guided walk through the review, one HTML document per comment set.
mod anchor;
mod blocks;
mod code;
mod diagram;
mod dom;
mod drawing;
mod element;
mod files;
mod placement;
mod reading;
mod stepped;
mod validate;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;

pub use anchor::TourIndex;
pub use files::column;

use crate::error::Result;
use crate::protocol::{CommentAnchor, CommentThread, Side, Snapshot, TourCheckItem, TourError, TourTarget};
use crate::session::Session;

/// The shown set's tour's checklist items in document order, each with its tick and the open thread
/// among `threads` that answers it.
pub async fn checklist(session: &Session, threads: &[CommentThread]) -> Result<Vec<TourCheckItem>> {
    let Some(tour) = session.comments()?.tour().await? else { return Ok(Vec::new()) };
    let mut items = TourIndex::read(&tour.tour.html).checks(tour.ticked());
    for item in &mut items {
        let answers = |t: &&CommentThread| {
            let on = matches!(&t.anchor, CommentAnchor::Tour { node, target: TourTarget::Element { .. }, .. } if *node == item.node);
            on && !t.stale && !t.resolved
        };
        item.thread = threads.iter().find(answers).map(|t| t.id.clone());
    }
    Ok(items)
}

/// The reasons to refuse `html` that need no file of the review.
pub fn outline_errors(html: &str) -> Vec<TourError> {
    validate::outline(html).errors.into_iter().map(|(_, e)| e).collect()
}

/// The judgment calls about `html` that need no file of the review.
#[cfg(test)]
pub fn outline_warnings(html: &str) -> Vec<TourError> {
    validate::outline(html).warnings.into_iter().map(|(_, e)| e).collect()
}

/// What checking a document found, each list in document order.
pub struct Verdict {
    /// Reasons to refuse it; none when it is fine.
    pub errors: Vec<TourError>,
    /// Judgment calls the agent fixes or keeps knowingly.
    pub warnings: Vec<TourError>,
}

/// Checks `html` as a tour of `snap`.
pub async fn check(session: &Session, snap: &Arc<Snapshot>, html: &str) -> Result<Verdict> {
    let outline = validate::outline(html);
    let mut texts: HashMap<(&str, Side), Option<String>> = HashMap::new();
    for reference in &outline.references {
        let Some(side) = reference.need.side() else { continue };
        if let Entry::Vacant(slot) = texts.entry((reference.path.as_str(), side)) {
            let bytes = session.read_side(snap, &reference.path, side).await?;
            slot.insert(bytes.map(|b| String::from_utf8_lossy(&b).into_owned()));
        }
    }
    let mut errors = outline.errors;
    for reference in &outline.references {
        let text = reference.need.side().and_then(|side| texts[&(reference.path.as_str(), side)].as_deref());
        let is_file = session.has_file(snap, &reference.path);
        errors.extend(files::refusal(reference, is_file, text).map(|e| (reference.node, e)));
    }
    // Stable: one element's findings keep the order they were found in.
    let ordered = |mut found: Vec<(usize, TourError)>| {
        found.sort_by_key(|(node, _)| *node);
        found.into_iter().map(|(_, e)| e).collect()
    };
    Ok(Verdict { errors: ordered(errors), warnings: ordered(outline.warnings) })
}
