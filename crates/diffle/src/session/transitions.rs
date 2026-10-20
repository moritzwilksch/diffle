//! Transitions relative to the active comparison: a commit of it, two of its iterations, or one pair.
use std::sync::Arc;

use super::{ResolvedReview, Session, range_of};
use crate::error::{Error, Result};
use crate::git::WORKTREE;
use crate::iterations::IterationStore;
use crate::mode::rangediff::compare_ranges;
use crate::protocol::{
    ComparisonBase, Iteration, Live, ModeSpec, PairSpec, PairStatus, RangeSide, comparison_label, plain_label,
};

/// A mode within `range`, refs-live unless the range is pinned: its refs still move it.
fn within(range: &crate::protocol::Comparison) -> Live {
    if range.live == Live::None { Live::None } else { Live::Refs }
}

impl Session {
    /// Focuses `commit`, by hash or short hash, of the active range's listed commits, `worktree` for
    /// the uncommitted changes of a range that ends there, or with none returns to the range. A
    /// focused commit keeps its own comments, as when entered alone, and the range's PR identity;
    /// the uncommitted changes share `working`'s.
    pub(super) async fn focus(self: &Arc<Self>, commit: Option<String>) -> Result<ResolvedReview> {
        let a = self.active()?;
        if a.mode.within.is_none() && a.mode.base == ComparisonBase::Parent {
            return Err(Error::revspec("a single commit has no commits to focus"));
        }
        let range = range_of(&a.mode);
        let label = plain_label(&range.old, &range.new, range.base);
        let pr_url = a.pr_url.clone();
        let mode = match commit.as_deref() {
            None => crate::mode::resolve::plain(range),
            Some(WORKTREE) => {
                if range.new != WORKTREE {
                    return Err(Error::revspec(format!("{label} has no uncommitted changes")));
                }
                ModeSpec {
                    old: "HEAD".into(),
                    new: WORKTREE.into(),
                    base: ComparisonBase::Direct,
                    live: Live::Worktree,
                    comment_key: "working".into(),
                    within: Some(range),
                    interdiff: None,
                    pair: None,
                }
            }
            Some(commit) => {
                let listed = a.snapshotter.current().await?;
                let Some(found) = listed.commits.list.iter().find(|c| c.sha == commit || c.short == commit) else {
                    return Err(Error::revspec(format!("not a listed commit of {label}: {commit}")));
                };
                let sha = found.sha.clone();
                ModeSpec {
                    old: sha.clone(),
                    new: sha.clone(),
                    base: ComparisonBase::Parent,
                    // The commit is pinned; refs still move the range, whose commits stay listed.
                    live: within(&range),
                    comment_key: format!("commit:{sha}"),
                    within: Some(range),
                    interdiff: None,
                    pair: None,
                }
            }
        };
        Ok(ResolvedReview { mode, pr_url })
    }

    /// Compares two recorded iterations of the active range, so only what the branch itself changed
    /// in between shows. The interdiff keeps its own comments and the range's PR identity.
    pub(super) async fn interdiff(self: &Arc<Self>, from: i64, to: i64) -> Result<ResolvedReview> {
        let a = self.active()?;
        let range = range_of(&a.mode);
        if range.base == ComparisonBase::Parent {
            return Err(Error::revspec("a single commit has no iterations"));
        }
        if from >= to {
            return Err(Error::revspec("compare an older iteration with a newer one"));
        }
        let store = IterationStore::new(self.repo.clone(), range.comment_key.clone());
        let (older, newer) = tokio::try_join!(store.get(from), store.get(to))?;
        let (Some(older), Some(newer)) = (older.clone(), newer) else {
            let missing = if older.is_some() { to } else { from };
            let label = plain_label(&range.old, &range.new, range.base);
            return Err(Error::revspec(format!("no iteration #{missing} of {label}")));
        };
        let side = |it: Iteration| RangeSide {
            old: it.old_sha.clone(),
            new: it.new_sha.clone(),
            old_sha: it.old_sha,
            new_sha: it.new_sha,
            iteration: Some(it.n),
        };
        let mode = compare_ranges(&self.repo, range, side(older), side(newer)).await?;
        Ok(ResolvedReview { mode, pr_url: a.pr_url.clone() })
    }

    /// Shows one pair of the active interdiff by its new-side commit: an added commit against its
    /// parent, an amended or reworded one against its old self replayed onto its parent. With none,
    /// the whole interdiff again. Identical pairs have nothing to show; dropped ones have no new side.
    pub(super) async fn pair(self: &Arc<Self>, commit: Option<String>) -> Result<ResolvedReview> {
        let a = self.active()?;
        let (Some(interdiff), Some(range)) = (a.mode.interdiff.clone(), a.mode.within.clone()) else {
            return Err(Error::revspec("no interdiff to pick a pair from"));
        };
        let pr_url = a.pr_url.clone();
        let Some(commit) = commit else {
            let mode = compare_ranges(&self.repo, range, interdiff.from, interdiff.to).await?;
            return Ok(ResolvedReview { mode, pr_url });
        };
        let found =
            interdiff.pairs.iter().find(|p| p.new.as_ref().is_some_and(|n| n.sha == commit || n.short == commit));
        let Some((found, new)) = found.and_then(|p| Some((p, p.new.clone()?))) else {
            return Err(Error::revspec(format!("not a commit of {}: {commit}", comparison_label(&a.mode))));
        };
        if found.status == PairStatus::Identical {
            return Err(Error::revspec(format!("{} is identical in both ranges", new.short)));
        }
        let live = within(&range);
        let mode = match &found.old {
            None => ModeSpec {
                old: new.sha.clone(),
                new: new.sha.clone(),
                base: ComparisonBase::Parent,
                live,
                comment_key: format!("commit:{}", new.sha),
                within: Some(range),
                interdiff: Some(interdiff.clone()),
                pair: Some(PairSpec { old: None, new: new.sha, conflicts: Vec::new() }),
            },
            Some(old) => {
                let (tree, conflicts) =
                    self.repo.replay(&format!("{}^", old.sha), &format!("{}^", new.sha), &old.sha).await?;
                ModeSpec {
                    old: tree,
                    new: new.sha.clone(),
                    base: ComparisonBase::Direct,
                    live,
                    comment_key: format!("{}:pair:{}-{}", range.comment_key, old.sha, new.sha),
                    within: Some(range),
                    interdiff: Some(interdiff.clone()),
                    pair: Some(PairSpec { old: Some(old.sha.clone()), new: new.sha, conflicts }),
                }
            }
        };
        Ok(ResolvedReview { mode, pr_url })
    }
}
