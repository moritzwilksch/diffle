//! The wire contract, generated from `src/shared/protocol.ts`, and the pure helpers both sides share.

#[allow(clippy::all, dead_code, unused_qualifications)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/protocol.rs"));
}
mod label;
mod language;
mod snapshot;

pub use generated::*;
pub use label::*;
pub use language::*;
pub use snapshot::*;

/** Mirrors `MAX_RANGE_COMMITS`: the commits a snapshot lists, and the most a range-diff takes. */
pub const MAX_RANGE_COMMITS: usize = 250;
