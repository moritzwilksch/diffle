//! Translate hosted review operations to GitHub REST and GraphQL calls.
use std::collections::HashMap;
use std::sync::Arc;

use futures::{FutureExt, future::BoxFuture};

use super::client::{GithubClient, no_token};
use super::comments;
use super::hosts::Github;
use super::metadata::discover_github;
use super::pending_review::{create_pending_review, find_pending_review, update_comment};
use super::pulls::repo_of_pr_url;
use super::review::export_to_github;
use super::submit_review::submit_review;
use super::viewed::{self, ViewedFiles};
use crate::error::{GithubError, Result};
use crate::git::GitRepo;
use crate::hosted_review::{
    CommentEdit, CurrentReview, FileState, ReviewProvider, ReviewTarget, ViewedReview, ensure_current,
};
use crate::protocol::{CommentThread, HostedComments, HostedExportResponse, HostedReviewSubmit, Snapshot, ViewedEntry};

impl Github {
    fn review_client(&self) -> Result<&Arc<dyn GithubClient>> {
        self.client.as_ref().ok_or_else(|| GithubError::conflict(no_token(&self.instance.host)).into())
    }
}

impl ReviewProvider for Github {
    fn target<'a>(
        &'a self,
        repo: &'a GitRepo,
        snapshot: &'a Snapshot,
        explicit_url: Option<&'a str>,
    ) -> BoxFuture<'a, Result<ReviewTarget>> {
        async move {
            self.review_client()?;
            let metadata = discover_github(repo, snapshot, self, explicit_url).await?;
            match (metadata.pull_request, metadata.reason) {
                (Some(pr), None) => Ok(ReviewTarget { url: pr.url, number: pr.number }),
                (_, reason) => {
                    Err(GithubError::conflict(reason.unwrap_or_else(|| "No matching pull request".into())).into())
                }
            }
        }
        .boxed()
    }

    fn comments<'a>(&'a self, target: &'a ReviewTarget) -> BoxFuture<'a, Result<HostedComments>> {
        async move { Ok(comments::read(self.review_client()?.as_ref(), target).await?) }.boxed()
    }

    fn change_comment<'a>(
        &'a self,
        target: &'a ReviewTarget,
        id: &'a str,
        edit: CommentEdit<'a>,
        current: CurrentReview<'a>,
    ) -> BoxFuture<'a, Result<()>> {
        async move {
            let client = self.review_client()?.as_ref();
            match edit {
                CommentEdit::Reply(body) => reply(client, target, id, body, current).await?,
                CommentEdit::SetResolved(resolved) => set_resolved(client, target, id, resolved, current).await?,
                CommentEdit::EditDraft(body) => {
                    let body = comments::pending_comment_edit(client, &target.url, id, body).await?;
                    ensure_current(current)?;
                    update_comment(client, id, &body).await?;
                }
                CommentEdit::DeleteDraft => {
                    let database_id = comments::pending_comment_id(client, &target.url, id).await?;
                    let (owner, repo) = repo_of_pr_url(&target.url)?;
                    ensure_current(current)?;
                    client.delete_review_comment(&owner, &repo, database_id).await?;
                }
            }
            Ok(())
        }
        .boxed()
    }

    fn export<'a>(
        &'a self,
        target: &'a ReviewTarget,
        head: &'a str,
        threads: &'a [CommentThread],
        thread_ids: Option<&'a [String]>,
    ) -> BoxFuture<'a, Result<HostedExportResponse>> {
        async move { Ok(export_to_github(self.review_client()?.as_ref(), head, target, threads, thread_ids).await?) }
            .boxed()
    }

    fn submit<'a>(
        &'a self,
        target: &'a ReviewTarget,
        head: &'a str,
        request: &'a HostedReviewSubmit,
        current: CurrentReview<'a>,
    ) -> BoxFuture<'a, Result<()>> {
        async move {
            let client = self.review_client()?.as_ref();
            let (id, pending) = find_pending_review(client, &target.url, target.number).await?;
            ensure_current(current)?;
            Ok(submit_review(client, &id, pending.as_deref(), head, request).await?)
        }
        .boxed()
    }

    fn viewed<'a>(&'a self, target: &'a ReviewTarget) -> BoxFuture<'a, Result<Option<Box<dyn ViewedReview>>>> {
        async move {
            let client = self.review_client()?.clone();
            let files = viewed::read(client.as_ref(), target).await?;
            Ok(Some(Box::new(GithubViewedReview { client, files }) as Box<dyn ViewedReview>))
        }
        .boxed()
    }
}

async fn reply(
    client: &dyn GithubClient,
    pull: &ReviewTarget,
    id: &str,
    body: &str,
    current: CurrentReview<'_>,
) -> Result<()> {
    let target = comments::thread_target(client, &pull.url, id).await?;
    if !target.viewer_can_reply {
        return Err(GithubError::conflict("You cannot reply to this GitHub thread").into());
    }
    let (pr_id, pending) = find_pending_review(client, &pull.url, pull.number).await?;
    ensure_current(current)?;
    let review_id = match pending {
        Some(id) => id,
        None => create_pending_review(client, &pr_id, &target.pull_request.head_ref_oid, &[]).await?,
    };
    ensure_current(current)?;
    Ok(comments::reply(client, id, &review_id, body).await?)
}

async fn set_resolved(
    client: &dyn GithubClient,
    pull: &ReviewTarget,
    id: &str,
    resolved: bool,
    current: CurrentReview<'_>,
) -> Result<()> {
    let target = comments::thread_target(client, &pull.url, id).await?;
    ensure_current(current)?;
    if target.is_resolved == resolved {
        return Ok(());
    }
    if !(if resolved { target.viewer_can_resolve } else { target.viewer_can_unresolve }) {
        return Err(GithubError::conflict("You cannot change this GitHub thread's resolution").into());
    }
    Ok(comments::set_resolved(client, id, resolved).await?)
}

struct GithubViewedReview {
    client: Arc<dyn GithubClient>,
    files: ViewedFiles,
}

impl ViewedReview for GithubViewedReview {
    fn base(&self) -> &str {
        self.files.base()
    }

    fn head(&self) -> &str {
        self.files.head()
    }

    fn states(&self) -> &HashMap<String, FileState> {
        &self.files.states
    }

    fn write<'a>(&'a mut self, entries: &'a [ViewedEntry], current: CurrentReview<'a>) -> BoxFuture<'a, Result<()>> {
        async move { Ok(self.files.write(self.client.as_ref(), entries, current).await?) }.boxed()
    }
}
