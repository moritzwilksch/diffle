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

/// One request's answer; `None` when no server could take it, which leaves a gap, not an error.
type Answer<T> = Result<Option<(T, Option<String>)>>;

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
        let Some(patch) = snapshotter.patch(&path).await? else { return Ok(None) };
        let outline = answer(pool.document_symbols(&path).await.map(|r| (r.symbols, r.inconclusive)))?;
        Ok::<_, Error>(outline.map(|(symbols, why)| (path, symbols, new_side_changes(&patch), why)))
    })
    .await;
    let mut outlines = HashMap::new();
    let mut changed = Vec::new();
    for file in changed_files {
        let Some((path, outline, changes, why)) = file? else { continue };
        reasons.extend(why);
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
        let (found, why) = answer?.unwrap_or_default();
        reasons.extend(why);
        locations.push(found);
    }

    let mut unread: Vec<String> =
        locations.iter().flatten().filter(|l| l.external.is_none()).map(|l| l.path.to_string()).collect();
    unread.sort_unstable();
    unread.dedup();
    unread.retain(|p| !outlines.contains_key(p));
    let more = map_limit(unread, PARALLEL, |path| async move {
        let outline = answer(pool.document_symbols(&path).await.map(|r| (r.symbols, r.inconclusive)))?;
        Ok::<_, Error>(outline.map(|o| (path, o)))
    })
    .await;
    for outline in more {
        let Some((path, (symbols, why))) = outline? else { continue };
        reasons.extend(why);
        outlines.insert(path, symbols);
    }

    let (nodes, edges) = link::link(changed, locations, &outlines);
    Ok(GraphResponse { nodes, edges, truncated, inconclusive: reasons.into_iter().next() })
}

async fn references(pool: &LspPool, symbol: &LspSymbol) -> Answer<Vec<LspLocation>> {
    let line = u64::try_from(symbol.line).ok().and_then(std::num::NonZeroU64::new);
    let (Some(line), Ok(path)) = (line, symbol.path.clone().try_into()) else { return Ok(None) };
    let pos = LspPosition { path, line, col: symbol.col };
    answer(pool.references(&pos).await.map(|r| (r.locations, r.inconclusive)))
}

/// A refusal for want of a server or a feature is a gap in the graph; anything else fails it.
fn answer<T>(result: Result<(T, Option<String>)>) -> Answer<T> {
    match result {
        Ok(found) => Ok(Some(found)),
        Err(Error::LspUnavailable(_) | Error::LspUnsupported(_)) => Ok(None),
        Err(e) => Err(e),
    }
}
