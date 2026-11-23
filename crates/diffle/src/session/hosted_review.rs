//! Keep remote review writes tied to the active comparison.
use std::sync::Arc;
use std::sync::atomic::Ordering;

use super::{Active, Session, pr_url};
use crate::comments::import::draft_for_review;
use crate::error::{Error, Result};
use crate::hosted_review::{CommentEdit, ReviewTarget, ensure_current};
use crate::protocol::{
    HostedCommentRequest, HostedComments, HostedExportResponse, HostedPendingCommentDelete, HostedPendingCommentEdit,
    HostedReviewSubmit, HostedThreadReply, HostedThreadResolution, Review, Snapshot, ThreadQuery, ThreadState,
};

enum Export {
    Local(Option<Vec<String>>),
    Draft(HostedCommentRequest),
}

impl Session {
    pub async fn hosted_comments(&self) -> Result<HostedComments> {
        let active = self.active()?;
        let target = explicit_target(&active.review, None)?;
        let comments = self.review_provider.comments(&target).await?;
        ensure_current(&|| self.is_active(&active))?;
        Ok(comments)
    }

    pub async fn reply_hosted_thread(&self, request: HostedThreadReply) -> Result<()> {
        self.change_hosted_comment(&request.review_url, &request.id, CommentEdit::Reply(checked_body(&request.body)?))
            .await
    }

    pub async fn resolve_hosted_thread(&self, request: HostedThreadResolution) -> Result<()> {
        self.change_hosted_comment(&request.review_url, &request.id, CommentEdit::SetResolved(request.resolved)).await
    }

    pub async fn edit_hosted_pending_comment(&self, request: HostedPendingCommentEdit) -> Result<()> {
        self.change_hosted_comment(
            &request.review_url,
            &request.id,
            CommentEdit::EditDraft(checked_body(&request.body)?),
        )
        .await
    }

    pub async fn delete_hosted_pending_comment(&self, request: HostedPendingCommentDelete) -> Result<()> {
        self.change_hosted_comment(&request.review_url, &request.id, CommentEdit::DeleteDraft).await
    }

    async fn change_hosted_comment(&self, expected_url: &str, id: &str, edit: CommentEdit<'_>) -> Result<()> {
        let _turn = self.review_writes.turn().await;
        let active = self.active()?;
        let target = explicit_target(&active.review, Some(expected_url))?;
        self.review_provider.change_comment(&target, id, edit, &|| self.is_active(&active)).await
    }

    pub async fn export_hosted_review(self: &Arc<Self>, ids: Option<Vec<String>>) -> Result<HostedExportResponse> {
        self.send_hosted_review(Export::Local(ids)).await
    }

    pub async fn send_hosted_comment(self: &Arc<Self>, draft: HostedCommentRequest) -> Result<HostedExportResponse> {
        self.send_hosted_review(Export::Draft(draft)).await
    }

    async fn send_hosted_review(self: &Arc<Self>, export: Export) -> Result<HostedExportResponse> {
        let _turn = self.review_writes.turn().await;
        let active = self.active()?;
        let snapshot = active.snapshotter.current().await?;
        ensure_current(&|| self.is_active(&active))?;
        if let Export::Draft(draft) = &export {
            explicit_target(&snapshot.review, None)?;
            ensure_current(&|| draft.version == snapshot.version)?;
        }
        let url = pr_url(&snapshot.review);
        let target = self.review_provider.target(&self.repo, &snapshot, url.as_deref()).await?;
        let (threads, ids) = match export {
            Export::Local(ids) => {
                let query = ThreadQuery { state: Some(ThreadState::All), path: None };
                (active.comments.threads(&query).await?, ids)
            }
            Export::Draft(draft) => {
                let id =
                    uuid::Uuid::parse_str(&draft.id).map_err(|_| Error::Invalid("invalid review draft ID".into()))?;
                (vec![draft_for_review(draft.comment, id, &self.anchor_source()?).await?], None)
            }
        };
        let latest = active.snapshotter.current().await?;
        ensure_current(&|| self.is_active(&active) && Arc::ptr_eq(&snapshot, &latest))?;
        self.review_provider.export(&target, &snapshot.new_sha, &threads, ids.as_deref()).await
    }

    pub async fn submit_hosted_review(&self, request: HostedReviewSubmit) -> Result<()> {
        let _turn = self.review_writes.turn().await;
        let active = self.active()?;
        let snapshot = active.snapshotter.current().await?;
        explicit_target(&snapshot.review, None)?;
        let current = || request.version == snapshot.version && self.is_current_review(&active, &snapshot);
        ensure_current(&current)?;
        let url = pr_url(&snapshot.review);
        let target = self.review_provider.target(&self.repo, &snapshot, url.as_deref()).await?;
        self.review_provider.submit(&target, &snapshot.new_sha, &request, &current).await
    }

    pub(super) fn is_current_review(&self, active: &Arc<Active>, snapshot: &Snapshot) -> bool {
        self.is_active(active) && self.version.load(Ordering::SeqCst) == snapshot.version
    }
}

fn explicit_target(review: &Review, expected_url: Option<&str>) -> Result<ReviewTarget> {
    let Review::Range { pr: Some(pr), .. } = review else {
        return Err(Error::ReviewConflict("Open a pull request with diffle pr".into()));
    };
    ensure_current(&|| expected_url.is_none_or(|url| url == pr.url))?;
    Ok(pr.into())
}

fn checked_body(body: &str) -> Result<&str> {
    let body = body.trim();
    if body.is_empty() { Err(Error::Invalid("Review comment cannot be empty".into())) } else { Ok(body) }
}
