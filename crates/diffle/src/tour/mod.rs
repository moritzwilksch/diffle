//! Tours: an agent's guided walk through the review, one HTML document per comment key.
mod dom;
mod files;
mod store;
mod validate;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;

pub use files::column;
pub use store::TourStore;

use crate::error::Result;
use crate::protocol::{Side, Snapshot, TourError};
use crate::session::Session;

/// Every reason to refuse `html` as a tour of `snap`, in document order; none when it is fine.
pub async fn refusals(session: &Session, snap: &Arc<Snapshot>, html: &str) -> Result<Vec<TourError>> {
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
    // Stable: one element's errors keep the order they were found in.
    errors.sort_by_key(|(node, _)| *node);
    Ok(errors.into_iter().map(|(_, e)| e).collect())
}
