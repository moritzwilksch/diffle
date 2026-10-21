//! Recomputing the active review: on change, on request, and when its refs move.
use std::sync::{Arc, Mutex};

use futures::FutureExt;

use super::{Active, Pending, Session};
use crate::error::{Error, Result};
use crate::iterations::IterationStore;
use crate::mode::resolve::resolve_range;
use crate::protocol::{Moved, RangeView, Review, ServerMessage, Snapshot, shown_iterations, with_view};

impl Session {
    /// Change context lines for the running session; clients refetch patches.
    pub async fn set_context(self: &Arc<Self>, context: u32) -> Result<()> {
        let this = self.clone();
        self.run(async move {
            if context == this.context() {
                return Ok(());
            }
            *this.context.lock().unwrap() = context;
            let Ok(a) = this.active() else { return Ok(()) };
            a.snapshotter.set_context(context, this.next_version());
            this.publish(&a).await.map(drop)
        })
        .await
    }

    /// Recompute the active snapshot and re-anchor comments against it. At most one refresh waits
    /// behind the running one: a burst of writes yields two recomputes, not one per write, and the
    /// second sees all of them. Failures are logged, not returned: nobody asked for this one.
    pub fn refresh(self: &Arc<Self>) -> Pending {
        let this = self.clone();
        self.coalesced(&self.queued_refresh, "refresh", async move {
            *this.queued_refresh.lock().unwrap() = None;
            this.recompute().await.map(drop)
        })
    }

    /// Queues `job` unless one is already waiting in `slot`, which the job clears when it starts.
    fn coalesced(
        &self,
        slot: &Mutex<Option<Pending>>,
        what: &'static str,
        job: impl Future<Output = Result<()>> + Send + 'static,
    ) -> Pending {
        let mut slot = slot.lock().unwrap();
        if let Some(pending) = slot.as_ref() {
            return pending.clone();
        }
        let ran = self.run(job);
        let pending = async move {
            if let Err(e) = ran.await {
                crate::status!("[diffle] {what} failed: {e}");
            }
        }
        .boxed()
        .shared();
        *slot = Some(pending.clone());
        // Driven on its own, so the job's outcome is logged even when nobody awaits it.
        tokio::spawn(pending.clone());
        pending
    }

    /// The reviewer asks for the moved refs: recompute now. Unlike `refresh`, a failure is the caller's.
    pub async fn reload(self: &Arc<Self>) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        self.run(async move {
            let a = this.active()?;
            // Two iterations are pinned; the moved refs belong to their range, where the reviewer continues.
            if shown_iterations(&a.review).is_some() {
                return this.leave_interdiff(&a).await;
            }
            this.recompute().await
        })
        .await
    }

    /// Forgets the range's recorded iterations and unpins their commits; its current state is recorded anew as #1.
    pub async fn clear_iterations(self: &Arc<Self>) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        self.run(async move {
            let a = this.active()?;
            this.iterations(&a)?.clear().await?;
            // An interdiff or pair of two iterations names iterations that no longer exist.
            if shown_iterations(&a.review).is_some() { this.leave_interdiff(&a).await } else { this.recompute().await }
        })
        .await
    }

    /// Forgets one recorded iteration and unpins its commits. The latest stays: it is the range's
    /// current state and would be recorded again at once.
    pub async fn delete_iteration(self: &Arc<Self>, n: i64) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        self.run(async move {
            let a = this.active()?;
            let store = this.iterations(&a)?;
            let list = store.list().await?;
            if !list.iter().any(|it| it.n == n) {
                return Err(Error::revspec(format!("no iteration #{n}")));
            }
            if list.last().is_some_and(|it| it.n == n) {
                return Err(Error::revspec(format!("#{n} is the latest iteration, the range's current state")));
            }
            store.remove(n).await?;
            // An interdiff or pair that names the forgotten iteration has nothing to compare any more.
            match shown_iterations(&a.review) {
                Some((from, to)) if from == n || to == n => this.leave_interdiff(&a).await,
                _ => this.recompute().await,
            }
        })
        .await
    }

    /// The active range's recorded iterations; a lone commit has none.
    fn iterations(&self, a: &Active) -> Result<IterationStore> {
        match &a.range_key {
            Some(key) => Ok(IterationStore::new(self.repo.clone(), key.clone())),
            None => Err(Error::revspec("a single commit has no iterations")),
        }
    }

    /// Back to the whole range, in place of the interdiff, and tells clients.
    async fn leave_interdiff(self: &Arc<Self>, a: &Active) -> Result<Arc<Snapshot>> {
        let range = with_view(&a.review, RangeView::Whole).expect("an interdiff lies within a range");
        let snap = self.activate(range).await?;
        self.hub.broadcast(ServerMessage::Snapshot { version: snap.version });
        Ok(snap)
    }

    /// Recomputes the active snapshot; every revision resolves again, so a range-diff of two
    /// named ranges follows the refs it was named by. From one of its pairs, back to the whole
    /// range-diff: the pair may no longer exist.
    async fn recompute(self: &Arc<Self>) -> Result<Arc<Snapshot>> {
        let a = self.active()?;
        if let Review::Range { view: RangeView::Interdiff { from, to, pair: Some(_) }, .. } = &a.review
            && shown_iterations(&a.review).is_none()
        {
            let view = RangeView::Interdiff { from: from.clone(), to: to.clone(), pair: None };
            let snap = self.activate(with_view(&a.review, view).expect("a range")).await?;
            self.hub.broadcast(ServerMessage::Snapshot { version: snap.version });
            return Ok(snap);
        }
        a.snapshotter.invalidate(self.next_version());
        self.publish(&a).await
    }

    /// Computes `a`'s current snapshot, re-anchors its threads (hunks may have grown, shrunk or
    /// moved), then broadcasts and announces it.
    async fn publish(self: &Arc<Self>, a: &Arc<Active>) -> Result<Arc<Snapshot>> {
        let snap = a.snapshotter.current().await?;
        self.relocate_comments(a, &snap).await?;
        // The snapshot resolved the refs afresh; a signal arriving later compares against it.
        *a.moved.lock().unwrap() = None;
        self.hub.broadcast(ServerMessage::Snapshot { version: snap.version });
        self.announce(&snap);
        Ok(snap)
    }

    /// Resolves the refs the live comparison follows and tells clients when they left the snapshot
    /// behind, or came back to it. At most one check waits behind the running one, as with `refresh`.
    pub(super) fn check_moved(self: &Arc<Self>, a: Arc<Active>) -> Pending {
        let this = self.clone();
        self.coalesced(&self.queued_check, "refs check", async move {
            *this.queued_check.lock().unwrap() = None;
            if !this.is_active(&a) {
                return Ok(());
            }
            let snap = a.snapshotter.current().await?;
            let Review::Range { old, new, base, .. } = &a.review else { return Ok(()) };
            let ends = resolve_range(&this.repo, old, new, *base).await?;
            let moved = (ends.old_sha != snap.commits.old_sha || ends.new_sha != snap.commits.new_sha).then(|| Moved {
                version: snap.version,
                old_sha: ends.old_sha,
                new_sha: ends.new_sha,
            });
            let mut current = a.moved.lock().unwrap();
            let same = |a: &Option<Moved>, b: &Option<Moved>| {
                a.as_ref().map(|m| (&m.old_sha, &m.new_sha)) == b.as_ref().map(|m| (&m.old_sha, &m.new_sha))
            };
            if same(&current, &moved) {
                return Ok(());
            }
            current.clone_from(&moved);
            drop(current);
            this.hub.broadcast(ServerMessage::Moved { moved });
            Ok(())
        })
    }
}
