//! What a build learns on the way: the sentences for the reader, the files left out, the links
//! the reference answers add up to, and whether the gathering was complete.
use std::collections::{BTreeMap, BTreeSet};

use super::assemble::{Callsite, Facts, GraphFile, SymbolEdge, SymbolKey};
use super::cache::Completeness;
use super::limits::Deadline;
use super::outlines::{Outline, key_of, line_u32};
use crate::protocol::{LspLocation, Snapshot};

/// Call-site lines kept per (symbol, caller); the response shows the first five.
const MAX_SITE_LINES: usize = 5;
pub const NOTE_INDEXING: &str = "language servers were still indexing: links may be missing";

/// Distinct sentences for the reader, in the order they were found.
#[derive(Default)]
pub struct Notes(Vec<String>);

impl Notes {
    pub fn add(&mut self, note: String) {
        if !self.0.contains(&note) {
            self.0.push(note);
        }
    }

    pub fn extend(&mut self, note: Option<String>) {
        note.into_iter().for_each(|n| self.add(n));
    }

    pub fn merge(&mut self, other: Notes) {
        other.0.into_iter().for_each(|n| self.add(n));
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn line(&self) -> Option<String> {
        (!self.0.is_empty()).then(|| self.0.join("; "))
    }
}

/// Everything a build sets aside while it gathers.
#[derive(Default)]
pub struct Tally {
    pub notes: Notes,
    /// Changed files that were not graphed.
    pub other: BTreeSet<String>,
    /// Language-server queries that failed for a reason of their own (a timeout, a refusal).
    pub failed: u32,
    /// Another build later may find more: a server was indexing or failed, or the deadline came.
    pub degraded: bool,
}

/// The facts of a snapshot, and whether a later build could improve on them.
pub struct Gathered {
    pub facts: Facts,
    pub completeness: Completeness,
}

impl Tally {
    /// Closes the books: the failure and deadline sentences, then the facts.
    pub fn into_gathered(
        mut self,
        snap: &Snapshot,
        files: Vec<GraphFile>,
        found: Found,
        deadline: &Deadline,
    ) -> Gathered {
        if self.failed > 0 {
            self.notes.add(format!("{} language-server queries failed", self.failed));
            self.degraded = true;
        }
        if deadline.was_hit() {
            self.notes.add(format!("stopped after {} s: links may be missing", deadline.budget().as_secs()));
            self.degraded = true;
        }
        let completeness = if self.degraded { Completeness::Degraded } else { Completeness::Complete };
        let edges = found
            .edges
            .into_iter()
            .map(|((used, by), lines)| SymbolEdge { used, by, lines: lines.into_iter().collect() })
            .collect();
        let facts = Facts {
            version: snap.version,
            files,
            edges,
            callers: found.callers,
            other: self.other.into_iter().collect(),
            note: self.notes.line(),
        };
        Gathered { facts, completeness }
    }
}

/// What the reference answers add up to: links between changed symbols, and unchanged callers.
#[derive(Default)]
pub struct Found {
    /// (used, by) with the first lines in `by`'s file where the reference sits.
    edges: BTreeMap<(SymbolKey, SymbolKey), BTreeSet<u32>>,
    callers: BTreeMap<SymbolKey, BTreeMap<String, Callsite>>,
}

impl Found {
    fn record_edge(&mut self, used: &SymbolKey, by: SymbolKey, line: u32) {
        let lines = self.edges.entry((used.clone(), by)).or_default();
        lines.insert(line);
        while lines.len() > MAX_SITE_LINES {
            lines.pop_last();
        }
    }

    fn record_caller(&mut self, used: &SymbolKey, path: &str, line: u32) {
        let sites = self.callers.entry(used.clone()).or_default();
        let site = sites.entry(path.to_owned()).or_insert_with(|| Callsite { count: 0, lines: Vec::new() });
        site.count = site.count.saturating_add(1);
        site.lines.push(line);
        site.lines.sort_unstable();
        site.lines.dedup();
        site.lines.truncate(MAX_SITE_LINES);
    }
}

/// Reads a reference location: which changed symbol it sits in, or which unchanged file.
pub struct Sites<'a> {
    pub outlines: &'a BTreeMap<String, Outline>,
    pub changed: BTreeSet<&'a str>,
    pub tree: BTreeSet<&'a str>,
    pub changed_keys: BTreeSet<SymbolKey>,
}

impl Sites<'_> {
    /// Adds the locations that reference `used`. Outside the snapshot, the declaration itself and
    /// anything in a changed file's own code link nothing; a changed file's code is never context.
    pub fn absorb(&self, found: &mut Found, used: &SymbolKey, locations: &[LspLocation]) {
        for location in locations.iter().filter(|l| l.external != Some(true)) {
            let (path, line) = (location.path.as_str(), line_u32(location.line.get()));
            if path == used.path {
                continue;
            }
            match (self.outlines.get(path), self.changed.contains(path), self.tree.contains(path)) {
                (Some(outline), _, _) => {
                    let by = outline.spans.at(line).map(|i| key_of(&outline.symbols[i]));
                    if let Some(by) = by.filter(|k| self.changed_keys.contains(k)) {
                        found.record_edge(used, by, line);
                    }
                }
                (None, false, true) => found.record_caller(used, path, line),
                (None, true, _) | (None, false, false) => {}
            }
        }
    }
}
