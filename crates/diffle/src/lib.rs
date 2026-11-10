//! diffle's server: Git review state behind an HTTP and WebSocket API for the React client.

/// A status line on stderr. A closed stream is ignored, not a panic: the terminal that started
/// diffle may be gone before it shuts down.
#[macro_export]
macro_rules! status {
    ($($arg:tt)*) => {{
        use ::std::io::Write as _;
        // anstream drops the styles when stderr is not a terminal or NO_COLOR is set.
        let _ = writeln!(::anstream::stderr(), $($arg)*);
    }};
}
/// How diffle names itself to the servers it calls over HTTP.
pub const USER_AGENT: &str = concat!("diffle/", env!("CARGO_PKG_VERSION"));

pub mod cli;
pub mod comments;
pub mod concurrency;
pub mod error;
pub mod generated;
pub mod git;
pub mod github;
pub mod graph;
pub mod highlight;
pub mod iterations;
pub mod lsp;
pub mod mode;
pub mod persist;
pub mod protocol;
pub mod server;
pub mod session;
pub mod snapshotter;
pub mod tour;
pub mod user_config;
pub mod watcher;
