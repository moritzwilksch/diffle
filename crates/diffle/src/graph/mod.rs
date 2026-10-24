//! The connected-clusters graph: which changed files reference each other.
//!
//! `changed` finds the symbols a patch touched and `moved` sets aside the code that only changed
//! place, `louvain` groups files by their references, `assemble` turns those facts into the wire
//! `GraphResponse` and `links` draws each cluster's arrows; all of them are pure. `source` is what
//! the language servers answer, `settle` asks them and waits out their indexing, `outlines` reads
//! the changed files' outlines, `tally` adds up what the answers say, `limits` bounds a build,
//! `collect` gathers the facts, and `cache` builds one graph per snapshot.
pub mod assemble;
pub mod cache;
pub mod changed;
pub mod collect;
pub mod limits;
pub mod links;
pub mod louvain;
pub mod moved;
pub mod outlines;
pub mod settle;
pub mod source;
pub mod tally;
