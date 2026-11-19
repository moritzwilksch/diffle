//! The active review's pull request: discovered for the client, and the target of exports.
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;

use super::{Session, pr_url};
use crate::comments::import::draft_for_github;
use crate::error::{Error, GithubError, Result};
use crate::github::client::{GithubClient, no_token};
use crate::github::comments;
use crate::github::metadata::discover_github;
use crate::github::pending_review::{create_pending_review, find_pending_review, update_comment};
use crate::github::permalink::permalink;
use crate::github::review::ExportInput;
use crate::github::submit_review::submit_review;
use crate::protocol::{
    GithubCommentRequest, GithubExportResponse, GithubMetadata, GithubPullRequest, GithubReviewSubmit,
    GithubThreadReply, GithubThreadResolution, Permalink, PermalinkRequest, PullRef, Review, Snapshot, ThreadQuery,
    ThreadState,
};

enum Export {
    Local(Option<Vec<String>>),
    Draft(GithubCommentRequest),
}

/// How long one discovery answers for its snapshot before GitHub is asked again.
const DISCOVERY_TTL: Duration = Duration::from_secs(30);

fn changed() -> GithubError {
    GithubError::conflict("Comparison changed; try again")
}

impl Session {
    pub async fn reply_github_thread(&self, request: GithubThreadReply) -> Result<()> {
        let body = request.body.trim();
        if body.is_empty() {
            return Err(Error::Invalid("GitHub reply cannot be empty".into()));
        }
        let _turn = self.exporter.turn().await;
        let active = self.active()?;
        let (pr, client) = self.github_comment_target(&active.review, Some(&request.pr_url))?;
        let target = comments::thread_target(client, &pr.url, &request.id).await?;
        if !target.viewer_can_reply {
            return Err(GithubError::conflict("You cannot reply to this GitHub thread").into());
        }
        let (pr_id, pending) = find_pending_review(client, &pr.url, pr.number).await?;
        if !self.is_active(&active) {
            return Err(changed().into());
        }
        let review_id = match pending {
            Some(id) => id,
            None => create_pending_review(client, &pr_id, &target.pull_request.head_ref_oid, &[]).await?,
        };
        if !self.is_active(&active) {
            return Err(changed().into());
        }
        comments::reply(client, &request.id, &review_id, body).await?;
        Ok(())
    }

    pub async fn resolve_github_thread(&self, request: GithubThreadResolution) -> Result<()> {
        let _turn = self.exporter.turn().await;
        let active = self.active()?;
        let (pr, client) = self.github_comment_target(&active.review, Some(&request.pr_url))?;
        let target = comments::thread_target(client, &pr.url, &request.id).await?;
        if !self.is_active(&active) {
            return Err(changed().into());
        }
        if target.is_resolved == request.resolved {
            return Ok(());
        }
        if !(if request.resolved { target.viewer_can_resolve } else { target.viewer_can_unresolve }) {
            return Err(GithubError::conflict("You cannot change this GitHub thread's resolution").into());
        }
        comments::set_resolved(client, &request.id, request.resolved).await?;
        Ok(())
    }

    fn github_comment_target<'a>(
        &'a self,
        review: &'a Review,
        expected_url: Option<&str>,
    ) -> Result<(&'a PullRef, &'a dyn GithubClient)> {
        let Review::Range { pr: Some(pr), .. } = review else {
            return Err(GithubError::conflict("Open a pull request with diffle pr").into());
        };
        if expected_url.is_some_and(|url| url != pr.url) {
            return Err(changed().into());
        }
        let Some(client) = self.github.client.as_deref() else {
            return Err(GithubError::conflict(no_token(&self.github.instance.host)).into());
        };
        Ok((pr, client))
    }

    pub async fn delete_github_pending_comment(
        &self,
        request: crate::protocol::GithubPendingCommentDelete,
    ) -> Result<()> {
        let _turn = self.exporter.turn().await;
        let active = self.active()?;
        let (pr, client) = self.github_comment_target(&active.review, Some(&request.pr_url))?;
        let database_id = comments::pending_comment_id(client, &pr.url, &request.id).await?;
        if !self.is_active(&active) {
            return Err(changed().into());
        }
        let (owner, repo) = crate::github::pulls::repo_of_pr_url(&pr.url)?;
        client.delete_review_comment(&owner, &repo, database_id).await?;
        Ok(())
    }

    pub async fn edit_github_pending_comment(&self, request: crate::protocol::GithubPendingCommentEdit) -> Result<()> {
        let body = request.body.trim();
        if body.is_empty() {
            return Err(Error::Invalid("GitHub comment cannot be empty".into()));
        }
        let _turn = self.exporter.turn().await;
        let active = self.active()?;
        let (pr, client) = self.github_comment_target(&active.review, Some(&request.pr_url))?;
        let body = comments::pending_comment_edit(client, &pr.url, &request.id, body).await?;
        if !self.is_active(&active) {
            return Err(changed().into());
        }
        update_comment(client, &request.id, &body).await?;
        Ok(())
    }

    pub async fn github_comments(&self) -> Result<crate::protocol::GithubComments> {
        let active = self.active()?;
        let (pr, client) = self.github_comment_target(&active.review, None)?;
        let comments = comments::read(client, pr).await?;
        if !self.is_active(&active) {
            return Err(changed().into());
        }
        Ok(comments)
    }

    /// The pull request `snap` belongs to, cached apart from snapshot construction, so callers never
    /// hold the transition queue. A failed lookup is forgotten at once.
    pub async fn github_metadata(self: &Arc<Self>, snap: &Arc<Snapshot>) -> Result<GithubMetadata> {
        let a = self.active()?;
        // The snapshot must be one of the active review's: a discovery answers for one comparison.
        if a.review != snap.review {
            return Err(changed().into());
        }
        let task = {
            let mut cached = self.discovered.lock().unwrap();
            match cached.as_ref() {
                Some((at, expires, task)) if Arc::ptr_eq(at, snap) && *expires > Instant::now() => task.clone(),
                _ => {
                    let (this, target, pr_url) = (self.clone(), snap.clone(), pr_url(&a.review));
                    let lookup =
                        async move { discover_github(&this.repo, &target, &this.github, pr_url.as_deref()).await };
                    let task = lookup.boxed().shared();
                    *cached = Some((snap.clone(), Instant::now() + DISCOVERY_TTL, task.clone()));
                    task
                }
            }
        };
        let result = task.clone().await;
        if result.is_err() {
            let mut cached = self.discovered.lock().unwrap();
            if cached.as_ref().is_some_and(|(_, _, t)| t.ptr_eq(&task)) {
                *cached = None;
            }
        }
        result
    }

    /// The link to lines of the current snapshot, read afresh from local refs on every call.
    pub async fn permalink(&self, req: &PermalinkRequest) -> Result<Permalink> {
        let snap = self.snapshotter()?.current().await?;
        permalink(&self.repo, &snap, &self.github.instance, req).await
    }

    /// Adds threads to a pending review on the matching pull request, with fresh pull request data
    /// validated against the current comparison inside the export queue. The human submits it.
    pub async fn export_github(self: &Arc<Self>, thread_ids: Option<Vec<String>>) -> Result<GithubExportResponse> {
        self.send_github_review(Export::Local(thread_ids)).await
    }

    pub async fn send_github_comment(self: &Arc<Self>, draft: GithubCommentRequest) -> Result<GithubExportResponse> {
        self.send_github_review(Export::Draft(draft)).await
    }

    async fn send_github_review(self: &Arc<Self>, export: Export) -> Result<GithubExportResponse> {
        self.exporter
            .export(|| async {
                let a = self.active()?;
                let snap = a.snapshotter.current().await?;
                if !self.is_active(&a) {
                    return Err(changed().into());
                }
                if let Export::Draft(draft) = &export {
                    if pr_url(&snap.review).is_none() {
                        return Err(GithubError::conflict("Open a pull request with diffle pr").into());
                    }
                    if snap.version != draft.version {
                        return Err(changed().into());
                    }
                }
                let (client, pull_request) = self.review_target(&snap).await?;
                let (threads, thread_ids) = match export {
                    Export::Local(ids) => {
                        let threads =
                            a.comments.threads(&ThreadQuery { state: Some(ThreadState::All), path: None }).await?;
                        (threads, ids)
                    }
                    Export::Draft(draft) => {
                        let id = uuid::Uuid::parse_str(&draft.id)
                            .map_err(|_| Error::Invalid("invalid GitHub draft ID".into()))?;
                        let thread = draft_for_github(draft.comment, id, &self.anchor_source()?).await?;
                        (vec![thread], None)
                    }
                };
                if !self.is_active(&a) || !Arc::ptr_eq(&snap, &a.snapshotter.current().await?) {
                    return Err(changed().into());
                }
                Ok(ExportInput { new_sha: snap.new_sha.clone(), pull_request, threads, thread_ids, github: client })
            })
            .await
    }

    pub async fn submit_github_review(self: &Arc<Self>, request: GithubReviewSubmit) -> Result<()> {
        let _turn = self.exporter.turn().await;
        let active = self.active()?;
        let snap = active.snapshotter.current().await?;
        if pr_url(&snap.review).is_none() {
            return Err(GithubError::conflict("Open a pull request with diffle pr").into());
        }
        if request.version != snap.version || !self.is_active(&active) {
            return Err(changed().into());
        }
        let (client, pr) = self.review_target(&snap).await?;
        let (pr_id, pending) = find_pending_review(client.as_ref(), &pr.url, pr.number).await?;
        if !self.is_active(&active) || !Arc::ptr_eq(&snap, &active.snapshotter.current().await?) {
            return Err(changed().into());
        }
        submit_review(client.as_ref(), &pr_id, pending.as_deref(), &snap.new_sha, &request).await?;
        Ok(())
    }

    async fn review_target(&self, snap: &Arc<Snapshot>) -> Result<(Arc<dyn GithubClient>, GithubPullRequest)> {
        let Some(client) = self.github.client.clone() else {
            return Err(GithubError::conflict(no_token(&self.github.instance.host)).into());
        };
        let metadata = discover_github(&self.repo, snap, &self.github, pr_url(&snap.review).as_deref()).await?;
        match (metadata.pull_request, metadata.reason) {
            (Some(pr), None) => Ok((client, pr)),
            (_, reason) => {
                Err(GithubError::conflict(reason.unwrap_or_else(|| "No matching pull request".into())).into())
            }
        }
    }
}
