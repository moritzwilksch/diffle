//! Resolving a comparison to Git endpoints, and a reviewer's request to a comparison.
use crate::error::{Error, Result};
use crate::git::{GitRepo, WORKTREE};
use crate::github::hosts::{GithubInstance, github_repository};
use crate::protocol::{Comparison, ComparisonBase, Live, ModeRequest, ModeSpec, RangeSide};

use super::rangediff::compare_ranges;
use super::revspec::{ParsedRange, ParsedRevspec, parse_range_diff, parse_revspec};

pub struct Endpoints {
    pub old_sha: String,
    pub new_sha: String,
    pub live: Live,
}

/// Resolves a comparison to Git endpoints, for entering a mode and for every refresh. Revisions
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
///   <E hash>  <E hash>  parent      D           E          none
///
/// In an unborn repository, HEAD compared directly with worktree resolves to the empty tree.
/// Invalid revisions or missing merge bases are revspec errors.
pub async fn resolve_comparison(
    repo: &GitRepo,
    old: &str,
    new: &str,
    base: ComparisonBase,
    interdiff: bool,
) -> Result<Endpoints> {
    // An interdiff's old side is a tree the session wrote, which no revision names; both sides are pinned.
    // An added commit shown within one is an ordinary commit against its parent.
    if interdiff && base != ComparisonBase::Parent {
        return Ok(Endpoints { old_sha: old.to_owned(), new_sha: new.to_owned(), live: Live::None });
    }
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
    if base == ComparisonBase::Parent {
        if new_rev == WORKTREE {
            return Err(Error::revspec("the worktree is not a commit"));
        }
        old_sha = match repo.try_resolve(&format!("{new_rev}^")).await? {
            Some(parent) => parent,
            None => repo.empty_tree().await?,
        };
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

pub async fn resolve_mode(repo: &GitRepo, mode: &ModeSpec) -> Result<Endpoints> {
    resolve_comparison(repo, &mode.old, &mode.new, mode.base, mode.interdiff.is_some()).await
}

/// Whether either endpoint names a local or remote branch, HEAD on one included.
pub async fn names_branch(repo: &GitRepo, old: &str, new: &str) -> Result<bool> {
    let (old, new) = tokio::try_join!(repo.branch_ref(old), repo.branch_ref(new))?;
    Ok(old.is_some() || new.is_some())
}

/// Resolves a request that enters a comparison from scratch, as the CLI does.
pub async fn resolve_review(req: &ModeRequest, repo: &GitRepo, instance: &GithubInstance) -> Result<ModeSpec> {
    let parsed = match req {
        ModeRequest::RangeDiff { args } => return range_diff_review(repo, parse_range_diff(args)?, instance).await,
        ModeRequest::Working => {
            ParsedRevspec { old: "HEAD".into(), new: WORKTREE.into(), base: ComparisonBase::Direct }
        }
        ModeRequest::Revspec { args } => parse_revspec(args)?,
        ModeRequest::Pr { .. } => return Err(Error::Github("pull requests are resolved by the GitHub module".into())),
        _ => return Err(Error::revspec("this request depends on the active comparison")),
    };
    // A commit is pinned when entered: moving the ref it was named by, e.g. amending HEAD, makes a different commit.
    if parsed.base == ComparisonBase::Parent {
        let sha = resolve_comparison(repo, &parsed.old, &parsed.new, parsed.base, false).await?.new_sha;
        return Ok(ModeSpec {
            old: sha.clone(),
            new: sha.clone(),
            base: ComparisonBase::Parent,
            live: Live::None,
            comment_key: format!("commit:{sha}"),
            within: None,
            interdiff: None,
            pair: None,
        });
    }
    let key = matches!(req, ModeRequest::Working).then(|| "working".to_owned());
    Ok(plain(resolve_range(repo, &parsed, instance, key).await?))
}

/// A comparison as the mode that shows it on its own.
pub fn plain(c: Comparison) -> ModeSpec {
    ModeSpec {
        old: c.old,
        new: c.new,
        base: c.base,
        live: c.live,
        comment_key: c.comment_key,
        within: None,
        interdiff: None,
        pair: None,
    }
}

/// A range as a comparison: resolved for its liveness and keyed for its comments, unless `key` names them.
async fn resolve_range(
    repo: &GitRepo,
    parsed: &ParsedRevspec,
    instance: &GithubInstance,
    key: Option<String>,
) -> Result<Comparison> {
    let ends = resolve_comparison(repo, &parsed.old, &parsed.new, parsed.base, false).await?;
    let comment_key = match key {
        Some(key) => key,
        None => comment_key(repo, parsed, instance, &ends.old_sha, &ends.new_sha).await?,
    };
    Ok(Comparison { old: parsed.old.clone(), new: parsed.new.clone(), base: parsed.base, live: ends.live, comment_key })
}

/// Two ranges the reviewer named, compared. Both resolve now and the comparison is pinned; the
/// newer range is where "All changes" leads and whose refs are watched.
pub async fn range_diff_review(
    repo: &GitRepo,
    (older, newer): (ParsedRange, ParsedRange),
    instance: &GithubInstance,
) -> Result<ModeSpec> {
    let side = |parsed: &ParsedRange| {
        let parsed = parsed.clone();
        async move {
            let ends = resolve_comparison(repo, &parsed.old, &parsed.new, ComparisonBase::Direct, false).await?;
            Ok::<_, Error>(RangeSide {
                old: parsed.old,
                new: parsed.new,
                old_sha: ends.old_sha,
                new_sha: ends.new_sha,
                iteration: None,
            })
        }
    };
    let newer_spec = ParsedRevspec { old: newer.old.clone(), new: newer.new.clone(), base: ComparisonBase::Direct };
    let (range, from, to) =
        tokio::try_join!(resolve_range(repo, &newer_spec, instance, None), side(&older), side(&newer))?;
    compare_ranges(repo, range, from, to).await
}

/// Branch identities keep review state stable across pushes and local branch aliases. Keys read
/// like the comparison, with ... for a merge base and .. otherwise. For origin = github.com/o/r
/// and HEAD on feat tracking origin/feat:
///   origin/main...HEAD → range:o/r:main...o/r:feat
/// If feat tracks a fork, its identity becomes e.g. "contributor/r:feat", keeping forks distinct.
/// Without a GitHub upstream, branches use full refs (range:refs/heads/main...refs/heads/feat);
/// other endpoints their resolved hash or literal "worktree".
async fn comment_key(
    repo: &GitRepo,
    c: &ParsedRevspec,
    instance: &GithubInstance,
    old_sha: &str,
    new_sha: &str,
) -> Result<String> {
    let remotes = repo.remotes().await?;
    let identity = |rev: String| {
        let remotes = &remotes;
        async move {
            if let Some(upstream) = repo.upstream_branch(&rev).await? {
                let url = remotes.iter().find(|r| r.name == upstream.remote).map(|r| r.url.as_str());
                if let Some(repository) = url.and_then(|url| github_repository(url, instance)) {
                    return Ok::<_, Error>(Some(format!("{}:{}", repository.to_lowercase(), upstream.branch)));
                }
            }
            repo.branch_ref(&rev).await
        }
    };
    let (old, new) = tokio::try_join!(identity(c.old.clone()), identity(c.new.clone()))?;
    Ok(range_key(
        old.as_deref().unwrap_or(old_sha),
        new.as_deref().unwrap_or(new_sha),
        c.base == ComparisonBase::MergeBase,
    ))
}

pub fn range_key(old: &str, new: &str, merge_base: bool) -> String {
    format!("range:{old}{}{new}", if merge_base { "..." } else { ".." })
}

/// `<owner>/<repo>`, lowercased, from an https or scp-style remote url.
pub fn remote_slug(url: &str) -> String {
    let lower = url.strip_suffix(".git").unwrap_or(url).to_lowercase();
    let parts: Vec<&str> = lower.split(['/', ':']).collect();
    parts[parts.len().saturating_sub(2)..].join("/")
}
