//! diffle's server: Git review state behind an HTTP and WebSocket API for the React client.
pub mod cli;
pub mod comments;
pub mod concurrency;
pub mod error;
pub mod generated;
pub mod git;
pub mod github;
pub mod iterations;
pub mod mode;
pub mod persist;
pub mod protocol;
pub mod server;
pub mod session;
pub mod snapshotter;
pub mod user_config;
pub mod watcher;
