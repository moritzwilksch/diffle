//! Discovering the pull request a comparison belongs to, without changing the comparison.
use std::time::Duration;

use super::client::no_token;
use super::hosts::{Github, github_repository};
use super::pulls::{PullRequest, origin_repository, pull_requests_for_head, view_pr};
use crate::error::{Error, Result};
use crate::git::{GitRepo, WORKTREE};
use crate::protocol::{GithubMetadata, GithubPullRequest, GithubPullRequestState, Review, Snapshot};

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Enriches a comparison without fetching commits, changing its endpoints, or changing comment
/// storage. Without a client (no token), only the origin repository is known. A failed lookup is
/// a reason, not an error.
pub async fn discover_github(
    repo: &GitRepo,
    snap: &Snapshot,
    github: &Github,
    pr_url: Option<&str>,
) -> Result<GithubMetadata> {
    let instance = &github.instance;
    let repository = origin_repository(repo, instance).await?;
    let repository_url = repository.as_ref().map(|r| format!("https://{}/{r}", instance.host));
    let metadata = |pull_request: Option<GithubPullRequest>, reason: Option<String>| GithubMetadata {
        version: snap.version,
        repository: repository.clone(),
        repository_url: repository_url.clone(),
        pull_request,
        reason,
    };
    let Some(client) = &github.client else { return Ok(metadata(None, Some(no_token(&instance.host)))) };
    let found = match pr_url {
        Some(url) => view_pr(Some(url), Some(repo), client.as_ref(), instance, Some(LOOKUP_TIMEOUT)).await.map(Ok),
        None => matching_pr(repo, snap, github).await,
    };
    let pr = match found {
        Ok(Ok(pr)) => pr,
        Ok(Err(reason)) => return Ok(metadata(None, Some(reason))),
        Err(Error::Github(e)) => return Ok(metadata(None, Some(format!("Lookup failed: {}", e.message)))),
        Err(e) => return Err(e),
    };
    let reason = if pr.state != "OPEN" {
        Some("The pull request is not open".to_owned())
    } else if snap.old_sha == WORKTREE || snap.new_sha == WORKTREE {
        Some("GitHub cannot anchor comments to the worktree".to_owned())
    } else if snap.new_sha != pr.head_ref_oid {
        Some("The comparison does not end at the pull request head".to_owned())
    } else {
        match repo.merge_base(&pr.base_ref_oid, &pr.head_ref_oid).await {
            Ok(base) if base == snap.old_sha => None,
            Ok(_) => Some("The comparison does not match the pull request diff".to_owned()),
            Err(_) => Some("Fetch the pull request base to verify its diff".to_owned()),
        }
    };
    Ok(metadata(Some(summary(&pr)), reason))
}

/// The one open pull request from the new endpoint's upstream branch into the old one's, or why
/// there is none.
async fn matching_pr(repo: &GitRepo, snap: &Snapshot, github: &Github) -> Result<Result<PullRequest, String>> {
    let client = github.client.as_ref().expect("a client");
    let Review::Range { old, new, .. } = &snap.review else {
        return Ok(Err("A single commit belongs to no pull request".into()));
    };
    let (old, new, remotes) =
        tokio::try_join!(repo.upstream_branch(old), repo.upstream_branch(new), async { Ok(repo.remotes().await?) })?;
    let (Some(old), Some(new)) = (old, new) else {
        return Ok(Err("No branch with an upstream available for both endpoints".into()));
    };
    let repository = |remote: &str| {
        remotes.iter().find(|r| r.name == remote).and_then(|r| github_repository(&r.url, &github.instance))
    };
    let (Some(base_repo), Some(head_repo)) = (repository(&old.remote), repository(&new.remote)) else {
        return Ok(Err("Both branches must have GitHub remotes".into()));
    };
    let mut prs: Vec<PullRequest> =
        pull_requests_for_head(client.as_ref(), &base_repo, &new.branch, Some(&old.branch), Some(LOOKUP_TIMEOUT))
            .await?
            .into_iter()
            .filter(|pr| pr.head_repository.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(&head_repo)))
            .collect();
    Ok(match prs.len() {
        0 => Err("No matching pull request".into()),
        1 => Ok(prs.remove(0)),
        _ => Err("Multiple matching pull requests; open one explicitly".into()),
    })
}

pub fn summary(pr: &PullRequest) -> GithubPullRequest {
    GithubPullRequest {
        repository: pr.repository.clone(),
        number: pr.number,
        url: pr.url.clone(),
        title: pr.title.clone(),
        state: match pr.state.as_str() {
            "OPEN" => GithubPullRequestState::Open,
            "MERGED" => GithubPullRequestState::Merged,
            _ => GithubPullRequestState::Closed,
        },
        is_draft: pr.is_draft,
    }
}
