//! GitHub: which one a run talks to, its client, pull requests, pending reviews, and permalinks.
pub mod client;
pub mod comments;
pub mod hosts;
pub mod metadata;
pub mod pending_review;
pub mod permalink;
pub mod pulls;
pub mod review;
pub(crate) mod submit_review;
pub(crate) mod viewed;
