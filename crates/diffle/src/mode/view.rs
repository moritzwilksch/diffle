//! Resolving what a review shows: its slice of the range, or its commit, to Git endpoints.
use super::keys;
use super::rangediff::{pair_ranges, replay_range};
use super::resolve::{Endpoints, resolve_commit, resolve_range};
use crate::error::{Error, Result};
use crate::git::{GitRepo, WORKTREE};
use crate::iterations::IterationStore;
use crate::protocol::{
    ComparisonBase, Interdiff, Live, PairStatus, RangeEnds, RangeRef, RangeView, Review, comparison_label, range_of,
};

/// A review's slice, resolved: what the snapshot diffs, lists and follows, and where its comments live.
pub struct Shown {
    pub old_sha: String,
    pub new_sha: String,
    pub follows: Live,
    /// The range's own endpoints, which the commits list spans; a lone commit's parent and itself.
    pub range: RangeEnds,
    pub interdiff: Option<Interdiff>,
    /// The commit on screen, if one is: shown alone, focused, or an added commit of a pair.
    pub commit: Option<String>,
    /// Where its threads and viewed marks live. An interdiff has a key of its own for viewed
    /// marks, though no thread can be created there (`Session::anchor_source`).
    pub comment_key: String,
}

/// What `review` shows now. Revisions resolve afresh each time, so a followed range moves with its
/// refs; a recorded iteration resolves through `iterations`. Invalid input (a commit outside the
/// range's pairs, a missing iteration, the worktree where a commit is needed) is a revspec error.
pub async fn resolve_shown(
    repo: &GitRepo,
    review: &Review,
    iterations: Option<&IterationStore>,
    range_key: Option<&str>,
) -> Result<Shown> {
    let (old, new, base, pr, view) = match review {
        Review::Commit { sha } => {
            let ends = resolve_commit(repo, sha).await?;
            return Ok(Shown {
                range: RangeEnds { old_sha: ends.old_sha.clone(), new_sha: ends.new_sha.clone() },
                old_sha: ends.old_sha,
                new_sha: ends.new_sha,
                follows: Live::None,
                interdiff: None,
                commit: Some(sha.clone()),
                comment_key: keys::commit_key(sha),
            });
        }
        Review::Range { old, new, base, pr, view } => (old, new, *base, pr, view),
    };
    let ends = resolve_range(repo, old, new, base).await?;
    // A pull request's refs stay where the fetch put them; nothing moves them under the reviewer.
    let follows = if pr.is_some() { Live::None } else { ends.live };
    // A pinned slice still belongs to the range: its refs move the range, whose commits stay listed,
    // while worktree edits are not its concern.
    let pinned = if follows == Live::None { Live::None } else { Live::Refs };
    let range = RangeEnds { old_sha: ends.old_sha.clone(), new_sha: ends.new_sha.clone() };
    let label = || comparison_label(&range_of(review).expect("a range"));
    let range_key = range_key.unwrap_or_default();
    let shown = |old_sha: String, new_sha: String, commit: Option<String>, comment_key: String| Shown {
        old_sha,
        new_sha,
        follows,
        range: range.clone(),
        interdiff: None,
        commit,
        comment_key,
    };
    match view {
        RangeView::Whole => Ok(shown(ends.old_sha, ends.new_sha, None, range_key.to_owned())),
        // The commit is pinned; refs still move the range, whose commits stay listed.
        RangeView::Commit { sha } => {
            let ends = resolve_commit(repo, sha).await?;
            let out = shown(ends.old_sha, ends.new_sha, Some(sha.clone()), keys::commit_key(sha));
            Ok(Shown { follows: pinned, ..out })
        }
        RangeView::Uncommitted => {
            if new != WORKTREE {
                return Err(Error::revspec(format!("{} has no uncommitted changes", label())));
            }
            let ends = resolve_range(repo, "HEAD", WORKTREE, ComparisonBase::Direct).await?;
            Ok(Shown { follows: Live::Worktree, ..shown(ends.old_sha, ends.new_sha, None, keys::WORKING.into()) })
        }
        RangeView::Interdiff { from, to, pair } => {
            let (from, to) = tokio::try_join!(
                range_side(repo, iterations, &ends, Some(from), &label),
                range_side(repo, iterations, &ends, to.as_ref(), &label)
            )?;
            if from.new_sha == WORKTREE || to.new_sha == WORKTREE {
                return Err(Error::revspec("the worktree is not a commit"));
            }
            let pairs = pair_ranges(repo, &from, &to).await?;
            // Two iterations are keyed under their range; named ranges by what they resolved to.
            let key = match crate::protocol::shown_iterations(review) {
                Some((a, b)) => keys::interdiff_key(range_key, a, b),
                None => keys::range_diff_key(&from, &to),
            };
            let (mut out, conflicts) = match pair {
                None => {
                    let (tree, conflicts) = replay_range(repo, &from, &to).await?;
                    (shown(tree, to.new_sha.clone(), None, key), conflicts)
                }
                Some(sha) => match find_pair(&pairs, sha, &label)? {
                    // An added commit is an ordinary commit against its parent.
                    (None, new) => {
                        let ends = resolve_commit(repo, &new).await?;
                        (shown(ends.old_sha, ends.new_sha, Some(new.clone()), keys::commit_key(&new)), Vec::new())
                    }
                    (Some(old), new) => {
                        let (tree, conflicts) = repo.replay(&format!("{old}^"), &format!("{new}^"), &old).await?;
                        (shown(tree, new.clone(), None, keys::pair_key(range_key, &old, &new)), conflicts)
                    }
                },
            };
            out.interdiff = Some(Interdiff { from, to, pairs, conflicts });
            out.follows = pinned;
            Ok(out)
        }
    }
}

/// One side of an interdiff: a recorded iteration, a named range, or the range as it is now.
async fn range_side(
    repo: &GitRepo,
    iterations: Option<&IterationStore>,
    now: &Endpoints,
    side: Option<&RangeRef>,
    label: &impl Fn() -> String,
) -> Result<RangeEnds> {
    match side {
        None => Ok(RangeEnds { old_sha: now.old_sha.clone(), new_sha: now.new_sha.clone() }),
        Some(RangeRef::Named { old, new }) => {
            let ends = resolve_range(repo, old, new, ComparisonBase::Direct).await?;
            Ok(RangeEnds { old_sha: ends.old_sha, new_sha: ends.new_sha })
        }
        Some(RangeRef::Iteration { n }) => {
            let n = n.get() as i64;
            let Some(store) = iterations else {
                return Err(Error::revspec(format!("{} records no iterations", label())));
            };
            let Some(it) = store.get(n).await? else {
                return Err(Error::revspec(format!("no iteration #{n} of {}", label())));
            };
            Ok(RangeEnds { old_sha: it.old_sha, new_sha: it.new_sha })
        }
    }
}

/// The pair `sha` names by its new side, as the old and new hashes. Identical pairs have nothing
/// to show; dropped ones have no new side.
fn find_pair(
    pairs: &[crate::protocol::RangePair],
    sha: &str,
    label: &impl Fn() -> String,
) -> Result<(Option<String>, String)> {
    let found = pairs.iter().find(|p| p.new.as_ref().is_some_and(|n| n.sha == sha || n.short == sha));
    let Some((found, new)) = found.and_then(|p| Some((p, p.new.clone()?))) else {
        return Err(Error::revspec(format!("not a commit of {}: {sha}", label())));
    };
    if found.status == PairStatus::Identical {
        return Err(Error::revspec(format!("{} is identical in both ranges", new.short)));
    }
    Ok((found.old.as_ref().map(|o| o.sha.clone()), new.sha))
}
