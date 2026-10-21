//! Resolving a range to Git endpoints, and a reviewer's request to a review.
use crate::error::{Error, Result};
use crate::git::{GitRepo, WORKTREE};
use crate::github::hosts::Github;
use crate::protocol::{ComparisonBase, EnterRequest, Live, RangeView, Review};

use super::revspec::{ParsedRange, ParsedRevspec, parse_range_diff, parse_revspec};

pub struct Endpoints {
    pub old_sha: String,
    pub new_sha: String,
    pub live: Live,
}

/// Resolves a range to Git endpoints, for entering a review and for every refresh. Revisions
/// become full hashes; "worktree" is accepted on either side and stays literal unless replaced by
/// a merge base.
///
/// With main at C and HEAD at E, sharing ancestor B:
///   A--B--C  main
///       \--D--E  HEAD
///
///   old       new       base        oldSha      newSha     live
///   main      HEAD      direct      C           E          refs
///   main      HEAD      merge-base  B           E          refs
///   HEAD      worktree  direct      E           worktree   worktree
///   worktree  HEAD      direct      worktree    E          worktree
///   main      worktree  merge-base  B           worktree   worktree
///   <C hash>  <E hash>  direct      C           E          none
///
/// In an unborn repository, HEAD compared directly with worktree resolves to the empty tree.
/// Invalid revisions or missing merge bases are revspec errors.
pub async fn resolve_range(repo: &GitRepo, old: &str, new: &str, base: ComparisonBase) -> Result<Endpoints> {
    let has_worktree = old == WORKTREE || new == WORKTREE;
    let resolve = |rev: &str| {
        let rev = rev.to_owned();
        async move {
            if rev == WORKTREE {
                return Ok(rev);
            }
            match repo.resolve(&rev).await {
                Ok(sha) => Ok(sha),
                Err(e) if base == ComparisonBase::Direct && rev == "HEAD" && has_worktree && e.is_missing() => {
                    Ok(repo.empty_tree().await?)
                }
                Err(_) => Err(Error::revspec(format!("unknown revision: {rev}"))),
            }
        }
    };
    let (old_rev, new_rev) = tokio::try_join!(resolve(old), resolve(new))?;
    let mut old_sha = old_rev.clone();
    if base == ComparisonBase::MergeBase {
        let (a, b) = tokio::try_join!(merge_base_side(&old_rev, &resolve), merge_base_side(&new_rev, &resolve))?;
        old_sha = repo
            .merge_base(&a, &b)
            .await
            .map_err(|_| Error::revspec(format!("no merge base between {old} and {new}")))?;
    }
    let pinned = |rev: &str, sha: &str| rev.len() >= 7 && sha.starts_with(&rev.to_lowercase());
    let live = if has_worktree {
        Live::Worktree
    } else if pinned(old, &old_rev) && pinned(new, &new_rev) {
        Live::None
    } else {
        Live::Refs
    };
    Ok(Endpoints { old_sha, new_sha: new_rev, live })
}

/// A merge base against the worktree is taken against HEAD, the commit it sits on.
async fn merge_base_side<F, Fut>(sha: &str, resolve: &F) -> Result<String>
where
    F: Fn(&str) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    if sha == WORKTREE { resolve("HEAD").await } else { Ok(sha.to_owned()) }
}

/// One commit against its first parent: the parent, or the empty tree for a root commit.
pub async fn resolve_commit(repo: &GitRepo, sha: &str) -> Result<Endpoints> {
    if sha == WORKTREE {
        return Err(Error::revspec("the worktree is not a commit"));
    }
    let new_sha = repo.resolve(sha).await.map_err(|_| Error::revspec(format!("unknown revision: {sha}")))?;
    let old_sha = match repo.try_resolve(&format!("{new_sha}^")).await? {
        Some(parent) => parent,
        None => repo.empty_tree().await?,
    };
    Ok(Endpoints { old_sha, new_sha, live: Live::None })
}

/// Whether either endpoint names a local or remote branch, HEAD on one included.
pub async fn names_branch(repo: &GitRepo, old: &str, new: &str) -> Result<bool> {
    let (old, new) = tokio::try_join!(repo.branch_ref(old), repo.branch_ref(new))?;
    Ok(old.is_some() || new.is_some())
}

/// A range shown whole.
pub fn range(old: impl Into<String>, new: impl Into<String>, base: ComparisonBase) -> Review {
    Review::Range { old: old.into(), new: new.into(), base, pr: None, view: RangeView::Whole }
}

/// Resolves a request that enters a review from scratch, as the CLI does. Each revision is
/// checked now, so invalid input fails before anything is served.
pub async fn resolve_review(req: &EnterRequest, repo: &GitRepo, github: &Github) -> Result<Review> {
    let parsed = match req {
        EnterRequest::Pr { pr } => return super::pr::resolve_pr(pr.as_deref(), repo, github).await,
        EnterRequest::RangeDiff { args } => return range_diff_review(repo, parse_range_diff(args)?).await,
        EnterRequest::Working => return Ok(range("HEAD", WORKTREE, ComparisonBase::Direct)),
        EnterRequest::Revspec { args } => parse_revspec(args)?,
    };
    match parsed {
        // A commit is pinned when entered: moving the ref it was named by, e.g. amending HEAD, makes a different commit.
        ParsedRevspec::Commit(rev) => Ok(Review::Commit { sha: resolve_commit(repo, &rev).await?.new_sha }),
        ParsedRevspec::Range { old, new, base } => {
            resolve_range(repo, &old, &new, base).await?;
            Ok(range(old, new, base))
        }
    }
}

/// Two ranges the reviewer named, compared: the newer one is the review, where "All changes"
/// leads and whose refs are watched, shown against the older. Both resolve now, so a typo fails here.
async fn range_diff_review(repo: &GitRepo, (older, newer): (ParsedRange, ParsedRange)) -> Result<Review> {
    tokio::try_join!(
        resolve_range(repo, &older.old, &older.new, ComparisonBase::Direct),
        resolve_range(repo, &newer.old, &newer.new, ComparisonBase::Direct)
    )?;
    Ok(Review::Range {
        old: newer.old,
        new: newer.new,
        base: ComparisonBase::Direct,
        pr: None,
        view: RangeView::Interdiff {
            from: crate::protocol::RangeRef::Named { old: older.old, new: older.new },
            to: None,
            pair: None,
        },
    })
}

/// `<owner>/<repo>`, lowercased, from an https or scp-style remote url.
pub fn remote_slug(url: &str) -> String {
    let lower = url.strip_suffix(".git").unwrap_or(url).to_lowercase();
    let parts: Vec<&str> = lower.split(['/', ':']).collect();
    parts[parts.len().saturating_sub(2)..].join("/")
}
