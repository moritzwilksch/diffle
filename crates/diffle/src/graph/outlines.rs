//! The outlines of the changed files a language server can graph, and the symbols each patch touched.
use std::collections::{BTreeMap, BTreeSet};

use super::assemble::SymbolKey;
use super::changed::{Spans, changed_symbols};
use super::limits::{Deadline, Limits};
use super::moved::{Edits, unmoved};
use super::settle::{MAX_IN_FLIGHT, is_fatal, quiet};
use super::source::SymbolSource;
use super::tally::Tally;
use crate::concurrency::map_limit;
use crate::error::{Error, Result};
use crate::protocol::LspSymbol;

/// Files per patch read: few enough that the paths ride argv on every platform, many enough that a
/// large diff is a few hundred git calls rather than one per file.
const PATCH_BATCH: usize = 100;

/// A graphed file's outline, and the symbols of it the patch touched.
pub struct Outline {
    pub symbols: Vec<LspSymbol>,
    /// Which symbol holds a line, answered without scanning `symbols`.
    pub spans: Spans,
    pub changed: Vec<LspSymbol>,
    /// The server answered empty while still working.
    pub indexing: bool,
}

impl Outline {
    fn of(symbols: Vec<LspSymbol>, lines: &BTreeSet<u32>, indexing: bool) -> Self {
        let changed = changed_symbols(&symbols, lines).into_iter().cloned().collect();
        Self { spans: Spans::new(&symbols), symbols, changed, indexing }
    }
}

enum Outlined {
    Ready(Outline),
    /// Not graphed, with the server's reason.
    Skipped(String),
    /// The query failed for a reason of its own.
    Errored,
    /// The build's deadline came first.
    Unfinished,
}

/// The outline of every path that has changed lines, retrying once those a busy server left empty.
/// The files that cannot be outlined join `tally.other`, with the reason where there is one.
/// `witnesses` are files left out of the graph whose removed code may have moved into `paths`.
pub async fn outline_all<S: SymbolSource>(
    source: &S,
    paths: &[&str],
    witnesses: &[&str],
    limits: &Limits,
    deadline: &Deadline,
    tally: &mut Tally,
) -> Result<BTreeMap<String, Outline>> {
    let lines = read_lines(source, paths, witnesses, deadline, tally).await?;
    let mut outlines = BTreeMap::new();
    let asked = lines.keys().cloned().collect::<Vec<_>>();
    let first = outline_each(source, &asked, &lines, deadline).await?;
    place(first, &mut outlines, tally);
    let busy: Vec<String> = outlines.iter().filter(|(_, o)| o.indexing).map(|(p, _)| p.clone()).collect();
    if !busy.is_empty() {
        quiet(source, &limits.patience, deadline).await;
        let again = outline_each(source, &busy, &lines, deadline).await?;
        for path in &busy {
            outlines.remove(path);
        }
        place(again, &mut outlines, tally);
    }
    Ok(outlines)
}

/// The changed lines of each path, read in batches. A path no longer changed, or not read before
/// the deadline, is set aside. Moves are decided once every batch is in, over the whole diff: a block
/// can leave a file of one batch and land in a file of another. Hashes of lines are all that is held.
async fn read_lines<S: SymbolSource>(
    source: &S,
    paths: &[&str],
    witnesses: &[&str],
    deadline: &Deadline,
    tally: &mut Tally,
) -> Result<BTreeMap<String, BTreeSet<u32>>> {
    let mut edits = BTreeMap::new();
    for batch in paths.chunks(PATCH_BATCH) {
        let read = deadline.within(source.edits(batch)).await;
        let mut read = match read {
            Some(read) => read?,
            None => {
                tally.other.extend(batch.iter().map(|p| (*p).to_owned()));
                continue;
            }
        };
        for path in batch {
            match read.remove(*path) {
                Some(changed) => {
                    edits.insert((*path).to_owned(), changed);
                }
                None => {
                    tally.other.insert((*path).to_owned());
                }
            }
        }
    }
    let mut removed_from = Vec::new();
    // With nothing to graph, there is nothing a move could change.
    let witnesses = if edits.is_empty() { &[] } else { witnesses };
    for batch in witnesses.chunks(PATCH_BATCH) {
        // Best effort: a deadline here leaves a move unseen, never a file out of the graph.
        let Some(read) = deadline.within(source.edits(batch)).await else { break };
        removed_from.extend(read?.into_values());
    }
    let whole_diff: Vec<&Edits> = edits.values().chain(&removed_from).collect();
    let left = unmoved(&whole_diff);
    Ok(edits.keys().cloned().zip(left).collect())
}

async fn outline_each<S: SymbolSource>(
    source: &S,
    paths: &[String],
    lines: &BTreeMap<String, BTreeSet<u32>>,
    deadline: &Deadline,
) -> Result<Vec<(String, Outlined)>> {
    // Owned items: borrowed ones make the future too lifetime-generic to be spawned.
    let work: Vec<(String, BTreeSet<u32>)> =
        paths.iter().filter_map(|p| Some((p.clone(), lines.get(p)?.clone()))).collect();
    let done = map_limit(work, MAX_IN_FLIGHT, |(path, lines)| async move {
        let outlined = outline_file(source, &path, &lines, deadline).await?;
        Ok::<_, Error>((path, outlined))
    })
    .await;
    done.into_iter().collect()
}

async fn outline_file<S: SymbolSource>(
    source: &S,
    path: &str,
    lines: &BTreeSet<u32>,
    deadline: &Deadline,
) -> Result<Outlined> {
    if lines.is_empty() {
        return Ok(Outlined::Ready(Outline::of(Vec::new(), lines, false)));
    }
    let Some(reply) = deadline.within(source.outline(path)).await else { return Ok(Outlined::Unfinished) };
    match reply {
        Ok(r) => Ok(Outlined::Ready(Outline::of(r.symbols, lines, r.inconclusive.is_some()))),
        Err(Error::LspUnavailable(why) | Error::LspUnsupported(why)) => Ok(Outlined::Skipped(why)),
        Err(e) if is_fatal(&e) => Err(e),
        Err(_) => Ok(Outlined::Errored),
    }
}

/// Files `done` could outline join `outlines`; the rest are set aside in `tally`.
fn place(done: Vec<(String, Outlined)>, outlines: &mut BTreeMap<String, Outline>, tally: &mut Tally) {
    for (path, outlined) in done {
        match outlined {
            Outlined::Ready(outline) => {
                outlines.insert(path, outline);
            }
            Outlined::Skipped(why) => {
                tally.notes.add(why);
                tally.degraded = true;
                tally.other.insert(path);
            }
            Outlined::Errored => {
                tally.failed += 1;
                tally.other.insert(path);
            }
            Outlined::Unfinished => {
                tally.other.insert(path);
            }
        }
    }
}

/// A symbol is named by where its declaration starts, so a rename of it is a different node.
pub fn key_of(symbol: &LspSymbol) -> SymbolKey {
    SymbolKey { path: symbol.path.clone(), line: line_u32(symbol.line), name: symbol.name.clone(), kind: symbol.kind }
}

pub fn line_u32(n: impl TryInto<u32>) -> u32 {
    n.try_into().unwrap_or(u32::MAX)
}
