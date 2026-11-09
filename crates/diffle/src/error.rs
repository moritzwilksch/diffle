//! Errors a user's input can cause, which exit with status 2, and everything else.
use std::sync::Arc;

use thiserror::Error;

/// A Git operation that failed or was refused, in words for the user.
#[derive(Debug, Error, Clone)]
#[error("{message}")]
pub struct GitError {
    pub message: String,
    pub kind: GitErrorKind,
}

/// What a caller may want to tell apart from a plain failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitErrorKind {
    Failed,
    /// A revision that names nothing.
    Missing,
    /// No repository at the path.
    NotRepository,
}

impl GitError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), kind: GitErrorKind::Failed }
    }

    pub fn missing(message: impl Into<String>) -> Self {
        Self { message: message.into(), kind: GitErrorKind::Missing }
    }

    pub fn not_repository(message: impl Into<String>) -> Self {
        Self { message: message.into(), kind: GitErrorKind::NotRepository }
    }

    pub fn is_missing(&self) -> bool {
        self.kind == GitErrorKind::Missing
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
