//! Viewed marks are local unless the whole GitHub pull request is on screen.
use std::collections::HashMap;
use std::sync::atomic::Ordering;

use super::Session;
use crate::comments::CommentStore;
use crate::error::{GithubError, Result};
use crate::github::client::{GithubClient, no_token};
use crate::github::viewed::{self, FileState, ViewedFiles};
use crate::protocol::{PullRef, RangeView, Review, ServerMessage, Snapshot, ViewedEntry};

impl Session {
    pub async fn viewed_marks(&self) -> Result<Vec<ViewedEntry>> {
        let a = self.active()?;
        let local = a.comments.viewed().await?;
        let (Some(pr), Some(client)) = (whole_pr(&a.review), self.github.client.as_deref()) else {
            return Ok(local);
        };
        let snap = a.snapshotter.current().await?;
        // The review can open even if GitHub is unreachable or has advanced ahead of this diff.
        match self.pr_viewed(client, pr, &snap).await {
            Ok(remote) if self.is_active(&a) => Ok(project(local, &snap, &remote)),
            _ => Ok(local),
        }
    }

    pub async fn set_viewed_mark(&self, entry: ViewedEntry) -> Result<Vec<ViewedEntry>> {
        self.update_viewed(vec![entry], false).await
    }

    pub async fn set_viewed_marks(&self, entries: Vec<ViewedEntry>) -> Result<Vec<ViewedEntry>> {
        self.update_viewed(entries, true).await
    }

    async fn update_viewed(&self, entries: Vec<ViewedEntry>, bulk: bool) -> Result<Vec<ViewedEntry>> {
        let a = self.active()?;
        let Some(pr) = whole_pr(&a.review) else {
            return write_local(&a.comments, entries, bulk).await;
        };
        let client =
            self.github.client.as_deref().ok_or_else(|| GithubError::conflict(no_token(&self.github.instance.host)))?;
        let _turn = self.exporter.turn().await;
        let snap = a.snapshotter.current().await?;
        let current = || self.is_active(&a) && self.version.load(Ordering::SeqCst) == snap.version;
        if !current() {
            return Err(viewed::changed().into());
        }
        let blobs: HashMap<_, _> = snap.changed.iter().map(|file| (&file.path, &file.blob)).collect();
        if entries.iter().any(|e| blobs.get(&e.path) != Some(&&e.blob)) {
            return Err(viewed::changed().into());
        }

        let mut remote = self.pr_viewed(client, pr, &snap).await?;
        if entries.iter().any(|e| !remote.states.contains_key(&e.path)) {
            return Err(GithubError::conflict("A file is not part of the GitHub pull request").into());
        }
        let result = remote.write(client, &entries, current).await;
        if result.is_err() {
            // A failing batch may have applied some mutations, so any connected tabs reread GitHub.
            self.hub.broadcast(ServerMessage::Viewed);
        }
        result?;
        let local = write_local(&a.comments, entries, bulk).await?;
        Ok(project(local, &snap, &remote))
    }

    async fn pr_viewed(&self, client: &dyn GithubClient, pr: &PullRef, snap: &Snapshot) -> Result<ViewedFiles> {
        let remote = viewed::read(client, pr).await?;
        if remote.head() != snap.new_sha
            || !matches!(self.repo.merge_base(remote.base(), remote.head()).await, Ok(base) if base == snap.old_sha)
        {
            return Err(viewed::changed().into());
        }
        Ok(remote)
    }
}

fn whole_pr(review: &Review) -> Option<&PullRef> {
    match review {
        Review::Range { pr: Some(pr), view: RangeView::Whole, .. } => Some(pr),
        _ => None,
    }
}

async fn write_local(store: &CommentStore, entries: Vec<ViewedEntry>, bulk: bool) -> Result<Vec<ViewedEntry>> {
    if bulk {
        return store.set_viewed_many(entries).await;
    }
    let entry = &entries[0];
    store.set_viewed(&entry.path, &entry.blob, entry.viewed).await
}

fn project(mut local: Vec<ViewedEntry>, snap: &Snapshot, remote: &ViewedFiles) -> Vec<ViewedEntry> {
    let blobs: HashMap<_, _> = snap
        .changed
        .iter()
        .filter(|file| remote.states.contains_key(&file.path))
        .map(|file| (&file.path, &file.blob))
        .collect();
    local.retain(|entry| blobs.get(&entry.path) != Some(&&entry.blob));
    for file in &snap.changed {
        let Some(&state) = remote.states.get(&file.path) else { continue };
        // Keep the "changed since viewed" presentation when Diffle knows the old blob.
        if state == FileState::Dismissed && local.iter().any(|entry| entry.path == file.path && entry.viewed) {
            continue;
        }
        local.push(ViewedEntry {
            path: file.path.clone(),
            blob: file.blob.clone(),
            viewed: state == FileState::Viewed,
        });
    }
    local
}
