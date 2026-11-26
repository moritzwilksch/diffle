//! Sync viewed marks when the whole hosted review is on screen.
use std::collections::HashMap;

use super::Session;
use crate::comments::CommentStore;
use crate::error::{Error, Result};
use crate::hosted_review::{FileState, ReviewTarget, ViewedReview};
use crate::protocol::{PullRef, RangeView, Review, ServerMessage, Snapshot, ViewedEntry};

impl Session {
    pub async fn viewed_marks(&self) -> Result<Vec<ViewedEntry>> {
        let a = self.active()?;
        let local = a.comments.viewed().await?;
        let Some(pr) = whole_pr(&a.review) else {
            return Ok(local);
        };
        let snap = a.snapshotter.current().await?;
        // The review can open even if the provider is unreachable or has advanced ahead of this diff.
        match self.pr_viewed(pr, &snap).await {
            Ok(Some(remote)) if self.is_active(&a) => Ok(project(local, &snap, remote.as_ref())),
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
        let _turn = self.review_writes.turn().await;
        let snap = a.snapshotter.current().await?;
        let current = || self.is_current_review(&a, &snap);
        if !current() {
            return Err(changed());
        }
        let blobs: HashMap<_, _> = snap.changed.iter().map(|file| (&file.path, &file.blob)).collect();
        if entries.iter().any(|e| blobs.get(&e.path) != Some(&&e.blob)) {
            return Err(changed());
        }

        let Some(mut remote) = self.pr_viewed(pr, &snap).await? else {
            return write_local(&a.comments, entries, bulk).await;
        };
        if entries.iter().any(|e| !remote.states().contains_key(&e.path)) {
            return Err(Error::ReviewConflict("A file is not part of the hosted review".into()));
        }
        let result = remote.write(&entries, &current).await;
        if result.is_err() {
            // A failing batch may have applied some mutations, so connected tabs reread remote marks.
            self.hub.broadcast(ServerMessage::Viewed);
        }
        result?;
        let local = write_local(&a.comments, entries, bulk).await?;
        Ok(project(local, &snap, remote.as_ref()))
    }

    async fn pr_viewed(&self, pr: &PullRef, snap: &Snapshot) -> Result<Option<Box<dyn ViewedReview>>> {
        let target = ReviewTarget::from(pr);
        let Some(remote) = self.review_provider.viewed(&target).await? else { return Ok(None) };
        if remote.head() != snap.new_sha
            || !matches!(self.repo.merge_base(remote.base(), remote.head()).await, Ok(base) if base == snap.old_sha)
        {
            return Err(changed());
        }
        Ok(Some(remote))
    }
}

fn changed() -> Error {
    Error::ReviewConflict("The pull request changed. Reopen it before marking files viewed.".into())
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

fn project(mut local: Vec<ViewedEntry>, snap: &Snapshot, remote: &dyn ViewedReview) -> Vec<ViewedEntry> {
    let blobs: HashMap<_, _> = snap
        .changed
        .iter()
        .filter(|file| remote.states().contains_key(&file.path))
        .map(|file| (&file.path, &file.blob))
        .collect();
    local.retain(|entry| blobs.get(&entry.path) != Some(&&entry.blob));
    for file in &snap.changed {
        let Some(&state) = remote.states().get(&file.path) else { continue };
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
