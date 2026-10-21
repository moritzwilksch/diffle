//! Entering a review and showing a slice of the active range: resolving what was asked, then
//! activating it in place of the current review.
use std::sync::{Arc, Mutex};

use super::{Active, Session};
use crate::comments::CommentStore;
use crate::error::{Error, Result};
use crate::iterations::IterationStore;
use crate::mode::keys::range_comment_key;
use crate::mode::resolve::{names_branch, resolve_range, resolve_review};
use crate::protocol::{
    EnterRequest, Live, RangeRef, RangeView, Review, ServerMessage, Snapshot, comparison_label, range_of, with_view,
};
use crate::snapshotter::Snapshotter;

impl Session {
    /// Resolves a request into a review without activating it, so a caller can reject invalid input
    /// before serving. Queued, so `close` waits for it.
    pub fn resolve(self: &Arc<Self>, req: EnterRequest) -> impl Future<Output = Result<Review>> + Send + use<> {
        let this = self.clone();
        self.run(async move { resolve_review(&req, &this.repo, &this.github).await })
    }

    /// First review, from `resolve`. Fails `ready` too, so early requests error out.
    pub async fn start(self: &Arc<Self>, review: Review) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        let result = self.run(async move { this.activate(review).await }).await;
        self.ready.send_replace(Some(result.as_ref().map(|_| ()).map_err(Clone::clone)));
        result
    }

    /// Enters another review at runtime. Broadcasts a snapshot bump on success.
    pub async fn enter(self: &Arc<Self>, req: EnterRequest) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        let snap = self
            .run(async move {
                let review = resolve_review(&req, &this.repo, &this.github).await?;
                this.activate(review).await
            })
            .await?;
        self.hub.broadcast(ServerMessage::Snapshot { version: snap.version });
        Ok(snap)
    }

    /// Shows a slice of the active range: one of its commits, its uncommitted changes, an
    /// interdiff of two of its iterations or one pair, or the whole range again.
    pub async fn show(self: &Arc<Self>, view: RangeView) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        let snap = self
            .run(async move {
                let review = this.view(view).await?;
                this.activate(review).await
            })
            .await?;
        self.hub.broadcast(ServerMessage::Snapshot { version: snap.version });
        Ok(snap)
    }

    pub(super) async fn activate(self: &Arc<Self>, review: Review) -> Result<Arc<Snapshot>> {
        let version = self.next_version();
        // A range that can move again gets its iterations recorded: one between refs, or a PR's,
        // fetched anew each run. Its key is the range's, whatever slice is shown.
        let (range_key, followed, branches) = match &review {
            Review::Commit { .. } => (None, false, false),
            Review::Range { old, new, base, pr, .. } => {
                let ends = resolve_range(&self.repo, old, new, *base).await?;
                let key = range_comment_key(
                    &self.repo,
                    &self.github.instance,
                    (old, new, *base),
                    pr.as_ref(),
                    (&ends.old_sha, &ends.new_sha),
                )
                .await?;
                let followed = ends.live == Live::Refs || pr.is_some();
                let branches = ends.live == Live::Refs && names_branch(&self.repo, old, new).await?;
                (Some(key), followed, branches)
            }
        };
        let iterations = followed.then(|| IterationStore::new(self.repo.clone(), range_key.clone().expect("a range")));
        let snapshotter =
            Snapshotter::new(self.repo.clone(), review.clone(), range_key.clone(), version, self.context(), iterations);
        let snap = snapshotter.current().await?;
        let comments = Arc::new(CommentStore::open(&self.repo.git_dir, &snap.comment_key).await?);
        let next = Arc::new(Active {
            review,
            range_key,
            follows: snap.follows,
            snapshotter,
            comments,
            watcher: tokio::sync::Mutex::new(None),
            moved: Mutex::new(None),
            branches,
        });
        // The repository may have moved on while no server was watching it.
        self.relocate_comments(&next, &snap).await?;
        if self.watch && next.follows != Live::None {
            *next.watcher.lock().await = Some(self.start_watcher(&next).await?);
        }
        let prev = self.active.lock().unwrap().replace(next);
        if let Some(prev) = prev
            && let Some(watcher) = prev.watcher.lock().await.take()
        {
            watcher.close().await;
        }
        self.announce(&snap);
        Ok(snap)
    }

    /// The active range with `view`, abbreviated hashes expanded against the current snapshot: a
    /// commit must be one of the range's listed commits, a pair one of the shown interdiff's. The
    /// rest (a missing iteration, a range without uncommitted changes) fails when the slice resolves.
    pub(super) async fn view(self: &Arc<Self>, view: RangeView) -> Result<Review> {
        let a = self.active()?;
        let Some(range) = range_of(&a.review) else {
            return Err(Error::revspec(match view {
                RangeView::Interdiff { .. } => "a single commit has no iterations",
                _ => "a single commit has no commits to focus",
            }));
        };
        let label = comparison_label(&range);
        let view = match view {
            RangeView::Commit { sha } => {
                let listed = a.snapshotter.current().await?;
                let Some(found) = listed.commits.list.iter().find(|c| c.sha == sha || c.short == sha) else {
                    return Err(Error::revspec(format!("not a listed commit of {label}: {sha}")));
                };
                RangeView::Commit { sha: found.sha.clone() }
            }
            RangeView::Interdiff { from, to, pair } => {
                if let (RangeRef::Iteration { n: older }, Some(RangeRef::Iteration { n: newer })) = (&from, &to)
                    && older >= newer
                {
                    return Err(Error::revspec("compare an older iteration with a newer one"));
                }
                let pair = match pair {
                    None => None,
                    Some(sha) => {
                        let shown = a.snapshotter.current().await?;
                        let full = shown.interdiff.as_ref().and_then(|inter| {
                            inter.pairs.iter().find_map(|p| {
                                p.new.as_ref().filter(|n| n.sha == sha || n.short == sha).map(|n| n.sha.clone())
                            })
                        });
                        Some(full.unwrap_or(sha))
                    }
                };
                RangeView::Interdiff { from, to, pair }
            }
            view => view,
        };
        Ok(with_view(&range, view).expect("a range"))
    }
}
