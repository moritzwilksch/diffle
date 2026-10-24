//! The change graph: the snapshot's changed symbols and the code using them, all from the language
//! servers' outlines and references.
pub mod link;
pub mod symbols;

use std::collections::HashMap;
use std::sync::Arc;

use crate::comments::hunks::new_side_changes;
use crate::concurrency::map_limit;
use crate::error::{Error, Result};
use crate::lsp::pool::LspPool;
use crate::protocol::{ChangeStatus, GraphResponse, LspLocation, LspPosition, LspSymbol, Snapshot, language_of};
use crate::snapshotter::Snapshotter;

/// Changed symbols one graph holds; the rest are cut, in path and line order.
pub const MAX_NODES: usize = 80;
/// Language server requests in flight at once.
const PARALLEL: usize = 8;

/// One request's answer, and why the graph may lack something it would have said. A failed
/// request is a gap, not a failed graph: the graph gathers many advisory queries, and one server
/// cancelling one of them while it indexes should not cost the rest.
struct Answer<T> {
    found: Option<T>,
    why: Option<String>,
}

/// Builds the graph of `snap`, whose new side the servers read (the caller has checked).
pub async fn build(pool: &LspPool, snapshotter: &Arc<Snapshotter>, snap: &Snapshot) -> Result<GraphResponse> {
    let mut reasons = Vec::new();
    // Owned items: a closure over borrowed ones is not general enough for axum's `Send` bound.
    let files: Vec<String> = snap
        .changed
        .iter()
        .filter(|f| f.status != ChangeStatus::D && !f.binary && f.submodule.is_none() && language_of(&f.path).is_some())
        .map(|f| f.path.clone())
        .collect();

    let changed_files = map_limit(files, PARALLEL, |path| async move {
        let patch = snapshotter.patch(&path).await?;
        Ok::<_, Error>((outline(pool, &path).await, patch.map(|p| new_side_changes(&p)), path))
    })
    .await;
    let mut outlines = HashMap::new();
    let mut changed = Vec::new();
    for file in changed_files {
        let (outline, changes, path) = file?;
        reasons.extend(outline.why);
        let (Some(outline), Some(changes)) = (outline.found, changes) else { continue };
        changed.extend(symbols::changed_symbols(&outline, &changes));
        outlines.insert(path, outline);
    }
    changed.sort_by(|(a, _), (b, _)| (&a.path, a.line).cmp(&(&b.path, b.line)));
    let truncated = changed.len() > MAX_NODES;
    changed.truncate(MAX_NODES);

    let symbols: Vec<LspSymbol> = changed.iter().map(|(s, _)| s.clone()).collect();
    let references = map_limit(symbols, PARALLEL, |symbol| async move { references(pool, &symbol).await }).await;
    let mut locations = Vec::with_capacity(references.len());
    for answer in references {
        reasons.extend(answer.why);
        locations.push(answer.found.unwrap_or_default());
    }

    let mut unread: Vec<String> =
        locations.iter().flatten().filter(|l| l.external.is_none()).map(|l| l.path.to_string()).collect();
    unread.sort_unstable();
    unread.dedup();
    unread.retain(|p| !outlines.contains_key(p));
    let more = map_limit(unread, PARALLEL, |path| async move { (outline(pool, &path).await, path) }).await;
    for (outline, path) in more {
        reasons.extend(outline.why);
        outlines.extend(outline.found.map(|o| (path, o)));
    }

    let (nodes, edges) = link::link(changed, locations, &outlines);
    Ok(GraphResponse { nodes, edges, truncated, inconclusive: reasons.into_iter().next() })
}

/// The interface-level symbols of `path`.
async fn outline(pool: &LspPool, path: &str) -> Answer<Vec<LspSymbol>> {
    answer(pool.document_symbols(path).await.map(|r| (symbols::interface(r.symbols), r.inconclusive)))
}

async fn references(pool: &LspPool, symbol: &LspSymbol) -> Answer<Vec<LspLocation>> {
    let line = u64::try_from(symbol.line).ok().and_then(std::num::NonZeroU64::new);
    let (Some(line), Ok(path)) = (line, symbol.path.clone().try_into()) else {
        return Answer { found: None, why: None };
    };
    let pos = LspPosition { path, line, col: symbol.col };
    answer(pool.references(&pos).await.map(|r| (r.locations, r.inconclusive)))
}

/// No server for the language, or none offering the request, is a gap with nothing to explain.
fn answer<T>(result: Result<(T, Option<String>)>) -> Answer<T> {
    match result {
        Ok((found, why)) => Answer { found: Some(found), why },
        Err(Error::LspUnavailable(_) | Error::LspUnsupported(_)) => Answer { found: None, why: None },
        Err(e) => Answer { found: None, why: Some(e.to_string()) },
    }
}
