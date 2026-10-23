//! Which sides of a comparison GitHub can show, for permalinks: local refs only, so it answers at once.
use super::hosts::GithubInstance;
use super::pulls::origin_repository;
use crate::error::Result;
use crate::git::GitRepo;
use crate::protocol::{Published, Review, Snapshot};

/// Origin's GitHub page and whether each side's commit is in it: reachable from origin's
/// remote-tracking branches, or from the reviewed pull request this run fetched when it lives in
/// that repository. A failed reachability query counts as unpublished, which only hides permalinks.
pub async fn published(repo: &GitRepo, snap: &Snapshot, instance: &GithubInstance) -> Result<Published> {
    let repository = origin_repository(repo, instance).await?;
    let Some(repository) = repository else {
        return Ok(Published { version: snap.version, repository_url: None, old: false, new: false });
    };
    let mut prefixes = vec!["refs/remotes/origin".to_owned()];
    if let Review::Range { pr: Some(pr), .. } = &snap.review
        && pr.repository.eq_ignore_ascii_case(&repository)
    {
        prefixes.push(format!("{}/{}", repo.review_refs, pr.number));
    }
    let reachable = async |sha: &str| repo.reachable_from(sha, &prefixes).await.unwrap_or(false);
    // An interdiff's old side is a replay GitHub never saw.
    let old = async { snap.interdiff.is_none() && reachable(&snap.old_sha).await };
    let (old, new) = tokio::join!(old, reachable(&snap.new_sha));
    let repository_url = Some(format!("https://{}/{repository}", instance.host));
    Ok(Published { version: snap.version, repository_url, old, new })
}
