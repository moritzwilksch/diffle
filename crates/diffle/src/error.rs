//! Errors a user's input can cause, which exit with status 2, and everything else.
use std::sync::Arc;

use thiserror::Error;

/// A failed git invocation: the arguments it ran with, its exit code (none when killed), and stderr.
#[derive(Debug, Error, Clone)]
#[error("{message}")]
pub struct GitError {
    pub message: String,
    pub args: Vec<String>,
    pub code: Option<i32>,
    pub stderr: String,
}

impl GitError {
    pub fn refused(message: impl Into<String>, args: &[&str]) -> Self {
        Self {
            message: message.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            code: None,
            stderr: String::new(),
        }
    }

    /// Exit code 1 from `rev-parse --verify --quiet`: the revision names nothing.
    pub fn is_missing(&self) -> bool {
        self.code == Some(1)
    }
}

/// Cloneable, so one failed computation can answer every caller sharing it.
#[derive(Debug, Error, Clone)]
pub enum Error {
    #[error(transparent)]
    Git(#[from] GitError),
    /// A revision argument that cannot be parsed or resolved.
    #[error("{0}")]
    Revspec(String),
    #[error("{0}")]
    Github(String),
    #[error(transparent)]
    Other(Arc<anyhow::Error>),
}

impl Error {
    pub fn revspec(message: impl Into<String>) -> Self {
        Self::Revspec(message.into())
    }

    /// Whether the user caused it, so the CLI exits 2 and the API answers 4xx.
    pub fn is_user_error(&self) -> bool {
        !matches!(self, Self::Other(_))
    }
}

impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(Arc::new(e))
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        anyhow::Error::from(e).into()
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
