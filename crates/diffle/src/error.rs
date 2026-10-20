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

/// A GitHub precondition the user can fix (no token, no pull request, wrong mode) or a GitHub
/// failure, with the status the API answers it with: 400 for bad input, 409 for something to fix
/// first, 502 when GitHub refused or did not answer.
#[derive(Debug, Error, Clone)]
#[error("{message}")]
pub struct GithubError {
    pub message: String,
    pub status: u16,
}

impl GithubError {
    pub fn new(message: impl Into<String>, status: u16) -> Self {
        Self { message: message.into(), status }
    }

    /// Something to fix before GitHub can help: the default.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(message, 409)
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
    #[error(transparent)]
    Github(#[from] GithubError),
    /// A thread or message id that names nothing.
    #[error("not found: {0}")]
    NotFound(String),
    /// An anchor the snapshot cannot place: path absent on that side, or lines past the end.
    #[error("{0}")]
    Unquotable(String),
    /// A language server is off, still starting, gone, or busy past retrying: the API answers 409.
    #[error("{0}")]
    LspUnavailable(String),
    /// The server never advertised the feature; advisory requests answer nothing instead.
    #[error("{0}")]
    LspUnsupported(String),
    /// A request body that is not valid JSON or not the shape the route takes.
    #[error("{0}")]
    Invalid(String),
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
