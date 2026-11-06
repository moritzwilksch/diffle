//! The change graph: the snapshot's changed symbols and the code using them, all from the language
//! servers' outlines and references.
pub mod link;
pub mod moved;
pub mod select;
pub mod symbols;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::{Instant, timeout_at};

use crate::comments::hunks::new_side_changes;
use crate::concurrency::map_limit;
use crate::error::{Error, Result};
use crate::lsp::pool::LspPool;
use crate::protocol::{ChangeStatus, GraphResponse, LspLocation, LspPosition, LspSymbol, Snapshot, language_of};
use crate::snapshotter::Snapshotter;

/// Changed symbols one graph holds unless asked for all; past it the least telling files are cut
/// whole (`select`).
pub const MAX_NODES: usize = 120;
/// Language server requests in flight at once.
const PARALLEL: usize = 8;
/// How long a graph may take. A cold server can take minutes to index; past this the graph is
/// answered with what came back, and says so.
const BUDGET: Duration = Duration::from_secs(30);

/// One request's answer, and why the graph may lack something it would have said. A failed
/// request is a gap, not a failed graph: the graph gathers many advisory queries, and one server
/// cancelling one of them while it indexes should not cost the rest.
struct Answer<T> {
    found: Option<T>,
    why: Option<String>,
}

/// Builds the graph of `snap`, whose new side the servers read (the caller has checked), of at
/// most `cap` changed symbols, from the changed files under the folder `scope` when given.
pub async fn build(
    pool: &LspPool,
    snapshotter: &Arc<Snapshotter>,
    snap: &Snapshot,
    cap: Option<usize>,
    scope: Option<&str>,
) -> Result<GraphResponse> {
    let under = scope.map(|dir| format!("{dir}/"));
    let by = Instant::now() + BUDGET;
    let mut reasons = Vec::new();
    // Owned items: a closure over borrowed ones is not general enough for axum's `Send` bound.
    let files: Vec<String> = snap
        .changed
        .iter()
        .filter(|f| f.status != ChangeStatus::D && !f.binary && f.submodule.is_none() && language_of(&f.path).is_some())
        .filter(|f| under.as_ref().is_none_or(|dir| f.path.starts_with(dir.as_str())))
        .map(|f| f.path.clone())
        .collect();

    let moves = moved::Moves::of(&new_side_changes(&snapshotter.patch_all().await?));
    let changed_files = map_limit(files, PARALLEL, |path| async move {
        let patch = snapshotter.patch(&path).await?;
        Ok::<_, Error>((outline(pool, &path, by).await, patch.map(|p| new_side_changes(&p)), path))
    })
    .await;
    let mut outlines = HashMap::new();
    let mut changed = Vec::new();
    for file in changed_files {
        let (outline, changes, path) = file?;
        reasons.extend(outline.why);
        let (Some(outline), Some(mut changes)) = (outline.found, changes) else { continue };
        moves.drop_from(&mut changes);
        changed.extend(symbols::changed_symbols(&outline, &changes));
        outlines.insert(path, outline);
    }
    // Ranked, the references are asked most telling first too, so a budget run out costs the least.
    select::rank(&mut changed);
    let (changed, cut) = match cap {
        Some(cap) => select::keep(changed, cap),
        None => (changed, Vec::new()),
    };
    let cut = cut.iter().map(|c| link::node(&c.symbol, link::node_id(&c.symbol), c.status, None)).collect();

    let symbols: Vec<LspSymbol> = changed.iter().map(|c| c.symbol.clone()).collect();
    let references = map_limit(symbols, PARALLEL, |symbol| async move { references(pool, &symbol, by).await }).await;
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
    let more = map_limit(unread, PARALLEL, |path| async move { (outline(pool, &path, by).await, path) }).await;
    for (outline, path) in more {
        reasons.extend(outline.why);
        outlines.extend(outline.found.map(|o| (path, o)));
    }

    let changed = changed.into_iter().map(|c| (c.symbol, c.status)).collect();
    let (nodes, edges) = link::link(changed, locations, &outlines);
    Ok(GraphResponse { nodes, edges, cut, inconclusive: reasons.into_iter().next() })
}

/// The interface-level symbols of `path`.
async fn outline(pool: &LspPool, path: &str, by: Instant) -> Answer<Vec<LspSymbol>> {
    answer(timeout_at(by, pool.document_symbols(path)).await, |r| (symbols::interface(r.symbols), r.inconclusive))
}

async fn references(pool: &LspPool, symbol: &LspSymbol, by: Instant) -> Answer<Vec<LspLocation>> {
    let line = u64::try_from(symbol.line).ok().and_then(std::num::NonZeroU64::new);
    let (Some(line), Ok(path)) = (line, symbol.path.clone().try_into()) else {
        return Answer { found: None, why: None };
    };
    let pos = LspPosition { path, line, col: symbol.col };
    answer(timeout_at(by, pool.references(&pos)).await, |r| (r.locations, r.inconclusive))
}

/// No server for the language, or none offering the request, is a gap with nothing to explain;
/// a request past the budget is one that says so.
fn answer<R, T>(
    result: std::result::Result<Result<R>, tokio::time::error::Elapsed>,
    take: impl FnOnce(R) -> (T, Option<String>),
) -> Answer<T> {
    match result {
        Ok(Ok(r)) => {
            let (found, why) = take(r);
            Answer { found: Some(found), why }
        }
        Ok(Err(Error::LspUnavailable(_) | Error::LspUnsupported(_))) => Answer { found: None, why: None },
        Ok(Err(e)) => Answer { found: None, why: Some(e.to_string()) },
        Err(_) => Answer {
            found: None,
            why: Some(format!("the language servers took over {} s; links may be missing", BUDGET.as_secs())),
        },
    }
}
