//! Operations a hosting provider supplies for the active code review.
use std::collections::HashMap;

use futures::future::BoxFuture;

use crate::error::{Error, Result};
use crate::git::GitRepo;
use crate::protocol::{
    CommentThread, HostedComments, HostedExportResponse, HostedReviewSubmit, PullRef, Snapshot, ViewedEntry,
};

#[derive(Clone)]
pub struct ReviewTarget {
    pub url: String,
    pub number: i64,
}

impl From<&PullRef> for ReviewTarget {
    fn from(pr: &PullRef) -> Self {
        Self { url: pr.url.clone(), number: pr.number }
    }
}

pub enum CommentEdit<'a> {
    Reply(&'a str),
    SetResolved(bool),
    EditDraft(&'a str),
    DeleteDraft,
}

/// Rechecked by adapters immediately before a write, after any remote reads it needs.
pub type CurrentReview<'a> = &'a (dyn Fn() -> bool + Send + Sync);

pub trait ReviewProvider: Send + Sync {
    /// Resolves a matching, writable review for the snapshot and validates its comparison.
    fn target<'a>(
        &'a self,
        repo: &'a GitRepo,
        snapshot: &'a Snapshot,
        explicit_url: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ReviewTarget>>;

    fn comments<'a>(&'a self, target: &'a ReviewTarget) -> BoxFuture<'a, Result<HostedComments>>;

    fn change_comment<'a>(
        &'a self,
        target: &'a ReviewTarget,
        id: &'a str,
        edit: CommentEdit<'a>,
        current: CurrentReview<'a>,
    ) -> BoxFuture<'a, Result<()>>;

    fn export<'a>(
        &'a self,
        target: &'a ReviewTarget,
        head: &'a str,
        threads: &'a [CommentThread],
        thread_ids: Option<&'a [String]>,
    ) -> BoxFuture<'a, Result<HostedExportResponse>>;

    fn submit<'a>(
        &'a self,
        target: &'a ReviewTarget,
        head: &'a str,
        request: &'a HostedReviewSubmit,
        current: CurrentReview<'a>,
    ) -> BoxFuture<'a, Result<()>>;

    /// Returns no remote marks when the provider only supports local tracking.
    fn viewed<'a>(&'a self, target: &'a ReviewTarget) -> BoxFuture<'a, Result<Option<Box<dyn ViewedReview>>>>;
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FileState {
    Viewed,
    Unviewed,
    Dismissed,
}

pub trait ViewedReview: Send + Sync {
    fn head(&self) -> &str;
    fn base(&self) -> &str;
    fn states(&self) -> &HashMap<String, FileState>;
    fn write<'a>(&'a mut self, entries: &'a [ViewedEntry], current: CurrentReview<'a>) -> BoxFuture<'a, Result<()>>;
}

pub fn ensure_current(current: CurrentReview<'_>) -> Result<()> {
    if current() { Ok(()) } else { Err(Error::ReviewConflict("Comparison changed; try again".into())) }
}

/// Serializes remote review writes so retries cannot duplicate a thread in a pending review.
#[derive(Default)]
pub struct ReviewWrites(tokio::sync::Mutex<()>);

impl ReviewWrites {
    pub async fn turn(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.0.lock().await
    }
}
