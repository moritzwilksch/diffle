//! Where a review's threads and viewed marks live: keys fixed by what was entered, never by what
//! it resolved to, so they survive pushes, rebases and local branch aliases.
use crate::error::Result;
use crate::git::{GitRepo, WORKTREE};
use crate::github::hosts::{GithubInstance, github_repository};
use crate::protocol::{ComparisonBase, PullRef, RangeEnds, ref_name};

/// The uncommitted changes, whether entered as `working` or reached from a range ending at the worktree.
pub const WORKING: &str = "working";

/// A commit's own comments, the same whether it was entered alone or focused within a range.
pub fn commit_key(sha: &str) -> String {
    format!("commit:{sha}")
}

/// One pair of an interdiff: `old` amended into `new`, under the range both belong to.
pub fn pair_key(range_key: &str, old: &str, new: &str) -> String {
    format!("{range_key}:pair:{old}-{new}")
}

/// Two recorded iterations of a range compared, under the range.
pub fn interdiff_key(range_key: &str, from: i64, to: i64) -> String {
    format!("{range_key}:interdiff:{from}-{to}")
}

/// Two named ranges compared, by what they resolved to.
pub fn range_diff_key(from: &RangeEnds, to: &RangeEnds) -> String {
    format!("range-diff:{}..{}:{}..{}", from.old_sha, from.new_sha, to.old_sha, to.new_sha)
}

/// Keys read like the range, with ... for a merge base and .. otherwise.
pub fn range_key(old: &str, new: &str, merge_base: bool) -> String {
    format!("range:{old}{}{new}", if merge_base { "..." } else { ".." })
}

/// The key of a range as named. Branch identities keep review state stable across pushes and local
/// branch aliases. For origin = github.com/o/r and HEAD on feat tracking origin/feat:
///   origin/main...HEAD → range:o/r:main...o/r:feat
/// If feat tracks a fork, its identity becomes e.g. "contributor/r:feat", keeping forks distinct.
/// Without a GitHub upstream, branches use full refs (range:refs/heads/main...refs/heads/feat);
/// other endpoints their resolved hash or literal "worktree". A pull request is keyed by its
/// repositories and branches, so a fetched pull request and the same branches checked out share
/// their comments. `HEAD..worktree` is `working`, from wherever it is reached.
pub async fn range_comment_key(
    repo: &GitRepo,
    instance: &GithubInstance,
    (old, new, base): (&str, &str, ComparisonBase),
    pr: Option<&PullRef>,
    (old_sha, new_sha): (&str, &str),
) -> Result<String> {
    if let Some(pr) = pr {
        let head = pr.head_repository.as_ref().map_or_else(|| format!("deleted:{}", pr.url), |h| h.to_lowercase());
        let base_branch = format!("{}:{}", pr.repository.to_lowercase(), ref_name(old));
        return Ok(range_key(&base_branch, &format!("{head}:{}", ref_name(new)), true));
    }
    if old == "HEAD" && new == WORKTREE && base == ComparisonBase::Direct {
        return Ok(WORKING.to_owned());
    }
    let remotes = repo.remotes().await?;
    let identity = |rev: &str| {
        let (remotes, rev) = (&remotes, rev.to_owned());
        async move {
            if let Some(upstream) = repo.upstream_branch(&rev).await? {
                let url = remotes.iter().find(|r| r.name == upstream.remote).map(|r| r.url.as_str());
                if let Some(repository) = url.and_then(|url| github_repository(url, instance)) {
                    return Ok::<_, crate::error::Error>(Some(format!(
                        "{}:{}",
                        repository.to_lowercase(),
                        upstream.branch
                    )));
                }
            }
            repo.branch_ref(&rev).await
        }
    };
    let (old_id, new_id) = tokio::try_join!(identity(old), identity(new))?;
    Ok(range_key(
        old_id.as_deref().unwrap_or(old_sha),
        new_id.as_deref().unwrap_or(new_sha),
        base == ComparisonBase::MergeBase,
    ))
}
