//! Tours: an agent's guided walk through the review, one HTML document per comment key.
mod anchor;
mod code;
mod diagram;
mod dom;
mod drawing;
mod element;
mod files;
mod icon;
mod layout;
mod placement;
mod store;
mod validate;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;

pub use anchor::{TourIndex, spoken};
pub use files::column;
pub use store::TourStore;

use crate::error::Result;
use crate::protocol::{Side, Snapshot, TourError};
use crate::session::Session;

/// The reasons to refuse `html` that need no file of the review.
pub fn outline_errors(html: &str) -> Vec<TourError> {
    validate::outline(html).errors.into_iter().map(|(_, e)| e).collect()
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
    for code in &outline.codes {
        let Some(path) = code.path.as_deref() else { continue };
        if let Entry::Vacant(slot) = texts.entry((path, Side::New)) {
            let bytes = session.read_side(snap, path, Side::New).await?;
            slot.insert(bytes.map(|b| String::from_utf8_lossy(&b).into_owned()));
        }
    }
    let changed = if outline.codes.is_empty() {
        Default::default()
    } else {
        code::changed(&session.snapshotter()?.patch_all().await?)
    };
    let mut warnings = outline.warnings;
    for block in &outline.codes {
        let text = block.path.as_deref().and_then(|path| texts[&(path, Side::New)].as_deref());
        warnings.extend(code::warnings(block, text, &changed).into_iter().map(|w| (block.node, w)));
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
    Ok(Verdict { errors: ordered(errors), warnings: ordered(warnings) })
}
