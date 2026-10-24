//! One graph build per snapshot, shared by every request that arrives while it runs.
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

use crate::error::Result;
use crate::protocol::{GraphResponse, Snapshot};

/// Whether another build of the same snapshot could find more than this one did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completeness {
    Complete,
    /// A server was still indexing, a query failed or timed out, or the deadline came.
    Degraded,
}

type Build = Shared<BoxFuture<'static, Result<(Arc<GraphResponse>, Completeness)>>>;

struct Slot {
    snap: Arc<Snapshot>,
    /// Tells this build from a retry of the same snapshot, so a late failure evicts only itself.
    token: u64,
    build: Build,
}

#[derive(Default)]
struct Inner {
    next_token: u64,
    slot: Option<Slot>,
}

/// The graph of the latest snapshot asked about. A snapshot is the same `Arc` until the session
/// replaces it, so pointer identity is the version check; a new snapshot drops the old build.
#[derive(Default)]
pub struct GraphCache {
    inner: Mutex<Inner>,
}

impl GraphCache {
    /// The graph for `snap`: the build already running or finished for it, else `start`'s. A
    /// complete graph stays for the snapshot's life. A failed or degraded one is answered to every
    /// caller that shared the build and then dropped, so the next call builds afresh. The lock is
    /// never held across an await.
    pub async fn get(
        &self,
        snap: &Arc<Snapshot>,
        start: impl FnOnce() -> BoxFuture<'static, Result<(GraphResponse, Completeness)>>,
    ) -> Result<Arc<GraphResponse>> {
        let (build, token) = {
            let mut inner = self.lock();
            match inner.slot.as_ref().filter(|s| Arc::ptr_eq(&s.snap, snap)) {
                Some(slot) => (slot.build.clone(), slot.token),
                None => {
                    inner.next_token += 1;
                    let token = inner.next_token;
                    let build: Build = start().map(|r| r.map(|(g, c)| (Arc::new(g), c))).boxed().shared();
                    inner.slot = Some(Slot { snap: snap.clone(), token, build: build.clone() });
                    (build, token)
                }
            }
        };
        let result = build.await;
        if !matches!(result, Ok((_, Completeness::Complete))) {
            let mut inner = self.lock();
            if inner.slot.as_ref().is_some_and(|s| s.token == token) {
                inner.slot = None;
            }
        }
        result.map(|(graph, _)| graph)
    }

    /// A build that panicked mid-way leaves the slot consistent, so a poisoned lock is still good.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::error::Error;

    fn snapshot(version: i64) -> Arc<Snapshot> {
        Arc::new(
            serde_json::from_value(json!({
                "root": "/r", "version": version, "oldSha": "a", "newSha": "worktree", "headSha": "", "context": 3,
                "review": { "kind": "range", "old": "HEAD", "new": "worktree", "base": "direct", "view": { "kind": "whole" } },
                "follows": "worktree", "commentKey": "working", "changed": [], "tree": [], "commit": null,
                "commits": { "list": [], "total": 0, "oldSha": "a", "newSha": "worktree" }, "iterations": [],
            }))
            .unwrap(),
        )
    }

    fn graph(version: i64) -> GraphResponse {
        GraphResponse { version, clusters: Vec::new(), unlinked: Vec::new(), other: Vec::new(), note: None }
    }

    /// A build that takes a moment, so concurrent callers overlap, and counts how often it started.
    fn slow(starts: &Arc<AtomicUsize>, version: i64) -> BoxFuture<'static, Result<(GraphResponse, Completeness)>> {
        let starts = starts.clone();
        async move {
            starts.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok((graph(version), Completeness::Complete))
        }
        .boxed()
    }

    #[tokio::test]
    async fn concurrent_requests_for_one_snapshot_share_one_build() {
        let (cache, snap, starts) = (GraphCache::default(), snapshot(1), Arc::new(AtomicUsize::new(0)));
        let (a, b) = tokio::join!(cache.get(&snap, || slow(&starts, 1)), cache.get(&snap, || slow(&starts, 1)));
        assert_eq!((a.unwrap().version, b.unwrap().version, starts.load(Ordering::SeqCst)), (1, 1, 1));
    }

    #[tokio::test]
    async fn a_finished_build_answers_the_next_request_without_building() {
        let (cache, snap, starts) = (GraphCache::default(), snapshot(1), Arc::new(AtomicUsize::new(0)));
        cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_new_snapshot_rebuilds() {
        let (cache, starts) = (GraphCache::default(), Arc::new(AtomicUsize::new(0)));
        let (old, new) = (snapshot(1), snapshot(2));
        cache.get(&old, || slow(&starts, 1)).await.unwrap();
        let rebuilt = cache.get(&new, || slow(&starts, 2)).await.unwrap();
        assert_eq!((rebuilt.version, starts.load(Ordering::SeqCst)), (2, 2));
    }

    #[tokio::test]
    async fn a_failed_build_is_dropped_so_the_next_request_retries() {
        let (cache, snap, starts) = (GraphCache::default(), snapshot(1), Arc::new(AtomicUsize::new(0)));
        let failing = || async { Err(Error::Invalid("boom".into())) }.boxed();
        assert!(cache.get(&snap, failing).await.is_err());
        let retried = cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        assert_eq!((retried.version, starts.load(Ordering::SeqCst)), (1, 1));
    }

    #[tokio::test]
    async fn waiters_share_a_failed_build_and_one_retry_follows() {
        let (cache, snap, starts) = (GraphCache::default(), snapshot(1), Arc::new(AtomicUsize::new(0)));
        let failing_late = || {
            async {
                tokio::time::sleep(Duration::from_millis(60)).await;
                Err(Error::Invalid("late".into()))
            }
            .boxed()
        };
        // The second caller joins the build the first started, which fails late: both see the error.
        let first = cache.get(&snap, failing_late);
        let second = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cache.get(&snap, || slow(&starts, 1)).await
        };
        let (first, second) = tokio::join!(first, second);
        assert!(first.is_err());
        assert!(second.is_err());
        cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    fn degraded(starts: &Arc<AtomicUsize>, version: i64) -> BoxFuture<'static, Result<(GraphResponse, Completeness)>> {
        let starts = starts.clone();
        async move {
            starts.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok((graph(version), Completeness::Degraded))
        }
        .boxed()
    }

    #[tokio::test]
    async fn a_degraded_build_answers_the_callers_that_shared_it_and_is_not_kept() {
        let (cache, snap, starts) = (GraphCache::default(), snapshot(1), Arc::new(AtomicUsize::new(0)));
        let (a, b) = tokio::join!(cache.get(&snap, || degraded(&starts, 1)), cache.get(&snap, || degraded(&starts, 1)));
        assert_eq!((a.unwrap().version, b.unwrap().version, starts.load(Ordering::SeqCst)), (1, 1, 1));
        // The next request builds afresh, and a complete result then stays.
        cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        assert_eq!(starts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_request_joins_a_build_held_open_instead_of_starting_another() {
        let (cache, snap, starts) = (GraphCache::default(), snapshot(1), Arc::new(AtomicUsize::new(0)));
        let gate = Arc::new(tokio::sync::Notify::new());
        let held = |gate: Arc<tokio::sync::Notify>, starts: Arc<AtomicUsize>| {
            move || {
                async move {
                    starts.fetch_add(1, Ordering::SeqCst);
                    gate.notified().await;
                    Ok((graph(1), Completeness::Complete))
                }
                .boxed()
            }
        };
        let first = cache.get(&snap, held(gate.clone(), starts.clone()));
        let second = cache.get(&snap, held(gate.clone(), starts.clone()));
        let open = async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            gate.notify_waiters();
        };
        let (first, second, ()) = tokio::join!(first, second, open);
        assert_eq!((first.unwrap().version, second.unwrap().version, starts.load(Ordering::SeqCst)), (1, 1, 1));
    }

    #[tokio::test]
    async fn a_lock_poisoned_by_a_panic_elsewhere_still_serves() {
        let (cache, snap, starts) = (Arc::new(GraphCache::default()), snapshot(1), Arc::new(AtomicUsize::new(0)));
        let held = cache.clone();
        let _ = std::thread::spawn(move || {
            let _guard = held.inner.lock().unwrap();
            panic!("a build thread died holding the lock");
        })
        .join();
        assert!(cache.inner.is_poisoned());
        let got = cache.get(&snap, || slow(&starts, 1)).await.unwrap();
        assert_eq!(got.version, 1);
    }
}
