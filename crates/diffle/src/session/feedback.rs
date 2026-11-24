use std::sync::Arc;

use super::{Active, Session};
use crate::comments::activity::Change;
use crate::error::{Error, Result};
use crate::git::WORKTREE;
use crate::protocol::{
    CommentAnchor, CommentAuthor, CommentThread, FeedbackContext, FeedbackItem, FeedbackLocation, ReviewEvidence, Side,
    Snapshot,
};

const MAX_SOURCE_BYTES: usize = 1024 * 1024;

impl Session {
    async fn feedback_review(&self) -> Result<Arc<Active>> {
        let active = self.active()?;
        if let Some(error) = super::comments_off(&active.review) {
            return Err(error);
        }
        let key = active.comments.key();
        if key.starts_with("working:") && crate::mode::keys::working_key(&self.repo).await? != key {
            return Err(Error::Invalid(
                "the checkout changed; reload the review and list pending feedback again".into(),
            ));
        }
        Ok(active)
    }

    pub async fn pending_feedback(self: &Arc<Self>) -> Result<Vec<FeedbackItem>> {
        let this = self.clone();
        self.run(async move {
            let review = this.feedback_review().await?;
            review.comments.pending(&review.feedback_scope).await
        })
        .await
    }

    pub async fn feedback_context(self: &Arc<Self>, target: String) -> Result<FeedbackContext> {
        let this = self.clone();
        self.run(async move {
            let review = this.feedback_review().await?;
            let item = review.comments.feedback_item(&review.feedback_scope, &target).await?;
            let snap = review.snapshotter.current().await?;
            let (location, current) = this.locate_feedback(&snap, &item).await?;
            this.feedback_review().await?;
            Ok(FeedbackContext { item, location, current })
        })
        .await
    }

    pub async fn answer_feedback(self: &Arc<Self>, target: String, summary: String) -> Result<CommentThread> {
        let this = self.clone();
        self.run(async move {
            let review = this.feedback_review().await?;
            let (thread, added) = review.comments.answer(&review.feedback_scope, &target, summary).await?;
            if added {
                this.record([(Some(CommentAuthor::Agent), Change::Thread(thread.id.clone()))]);
            }
            Ok(thread)
        })
        .await
    }

    pub async fn follow_up(self: &Arc<Self>, id: String, body: String) -> Result<CommentThread> {
        let this = self.clone();
        self.run(async move {
            let active = this.feedback_review().await?;
            let thread = active.comments.get(&id).await?.ok_or_else(|| Error::NotFound(id.clone()))?;
            let evidence = if thread.stale {
                None
            } else {
                this.capture_evidence(&active.snapshotter.current().await?, &thread.anchor).await?
            };
            active.comments.follow_up(&id, body, evidence).await
        })
        .await
    }

    pub(super) async fn capture_evidence(
        &self,
        snap: &Arc<Snapshot>,
        anchor: &CommentAnchor,
    ) -> Result<Option<ReviewEvidence>> {
        let CommentAnchor::Line { path, side, start_line, end_line, quoted } = anchor else {
            return Ok(None);
        };
        let Some(bytes) = self.read_context_side(snap, path, *side).await? else {
            return Ok(ReviewEvidence::from_anchor(anchor));
        };
        let Some(contents) = text(&bytes) else { return Ok(ReviewEvidence::from_anchor(anchor)) };
        // A browser quote can refer to bytes that changed before the request arrived.
        let normalize = |quote: &str| quote.trim_end_matches('\r').replace("\r\n", "\n");
        if crate::comments::anchor::quote_range(contents, *start_line, *end_line)
            .is_none_or(|actual| normalize(&actual) != normalize(quoted))
        {
            return Ok(ReviewEvidence::from_anchor(anchor));
        }
        Ok(Some(ReviewEvidence::capture(path, *side, *start_line, *end_line, quoted, contents)))
    }

    async fn locate_feedback(
        &self,
        snap: &Arc<Snapshot>,
        item: &FeedbackItem,
    ) -> Result<(FeedbackLocation, Option<ReviewEvidence>)> {
        let Some(original) = &item.original else {
            let location = match item.anchor {
                CommentAnchor::File { .. } => FeedbackLocation::File,
                CommentAnchor::Tour { .. } => FeedbackLocation::Tour,
                CommentAnchor::Line { .. } => FeedbackLocation::Unavailable,
            };
            return Ok((location, None));
        };
        if original.side == Side::Old {
            return Ok((FeedbackLocation::OriginalSide, None));
        }
        if snap.new_sha != WORKTREE {
            return Ok((FeedbackLocation::Historical, None));
        }
        let path = if self.has_side(snap, &original.path, Side::New) {
            &original.path
        } else {
            let mut candidates = snap.changed.iter().filter(|file| file.old_path.as_deref() == Some(&original.path));
            let Some(renamed) = candidates.next() else { return Ok((FeedbackLocation::Unavailable, None)) };
            if candidates.next().is_some() {
                return Ok((FeedbackLocation::Ambiguous, None));
            }
            &renamed.path
        };
        let Some(bytes) = self.read_context_side(snap, path, Side::New).await? else {
            return Ok((FeedbackLocation::Unavailable, None));
        };
        let Some(contents) = text(&bytes) else { return Ok((FeedbackLocation::Unavailable, None)) };
        let (mut location, range) = original.locate(contents);
        if path != &original.path && location == FeedbackLocation::Unchanged {
            location = FeedbackLocation::Moved;
        }
        let current = range.and_then(|(start, end)| {
            let quote = crate::comments::anchor::quote_range(contents, start, end)?;
            Some(ReviewEvidence::capture(path, Side::New, start, end, &quote, contents))
        });
        Ok((location, current))
    }

    async fn read_context_side(&self, snap: &Arc<Snapshot>, path: &str, side: Side) -> Result<Option<Vec<u8>>> {
        let paths = self.readable_paths(snap);
        let Some(path) = super::side_path(&paths, path, side) else { return Ok(None) };
        let rev = if side == Side::New { &snap.new_sha } else { &snap.old_sha };
        Ok(self.repo.head(rev, path, MAX_SOURCE_BYTES + 1).await?)
    }
}

fn text(bytes: &[u8]) -> Option<&str> {
    if bytes.len() > MAX_SOURCE_BYTES || bytes.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes).ok()
}
