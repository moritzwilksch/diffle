//! The active review and everything derived from it, behind one serialized transition queue.
mod files;
mod github;
mod refresh;
mod transitions;
mod watch;

use std::future::Future;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use tokio::sync::{mpsc, oneshot, watch as signal};

use crate::comments::CommentStore;
use crate::error::{Error, Result};
use crate::git::GitRepo;
use crate::github::hosts::Github;
use crate::protocol::{FollowRefs, Live, Moved, RangeView, Review, ServerMessage, Snapshot, shown_iterations};
use crate::snapshotter::Snapshotter;
use crate::watcher::Watcher;

pub use files::{ReadablePaths, side_path};

/// Where clients hear about state changes: the WebSocket hub, or a recorder in tests.
pub trait Broadcaster: Send + Sync {
    fn broadcast(&self, msg: ServerMessage);
}

pub struct SessionOptions {
    pub watch: bool,
    /// Where GitHub is, deciding comment keys of ranges on its remotes; without a client (no
    /// token), pull request lookup and export are off.
    pub github: Github,
    /// Context lines for patches: `--context`, else the user config. Changed at runtime via `set_context`.
    pub context: u32,
    /// What a review between refs does when one moves. The user config; `set_follow_refs` changes it.
    pub follow_refs: FollowRefs,
}

struct Active {
    review: Review,
    /// Where the range's comments and iterations live, whatever slice is shown; a lone commit has none.
    range_key: Option<String>,
    /// What the first snapshot followed; a slice keeps following its range.
    follows: Live,
    snapshotter: Arc<Snapshotter>,
    comments: Arc<CommentStore>,
    watcher: tokio::sync::Mutex<Option<Watcher>>,
    /// Where a refs-live range's refs point now, when that differs from the snapshot; cleared by a reload.
    moved: Mutex<Option<Moved>>,
    /// Whether an endpoint of the followed range names a branch; decides what `auto` does with a move.
    branches: bool,
}

type Job = BoxFuture<'static, ()>;
type Discovery =
    (Arc<Snapshot>, std::time::Instant, Shared<BoxFuture<'static, Result<crate::protocol::GithubMetadata>>>);
type Listener = Box<dyn Fn(&Arc<Snapshot>) + Send + Sync>;
type Pending = Shared<BoxFuture<'static, ()>>;

/// Why no thread can be created in `review`, or none: an interdiff's old side is a replayed
/// tree, and its threads would live under a key the range never shows again.
fn comments_off(review: &Review) -> Option<Error> {
    let Review::Range { view: RangeView::Interdiff { .. }, .. } = review else { return None };
    Some(Error::revspec(if shown_iterations(review).is_some() {
        "comments are off while comparing iterations"
    } else {
        "comments are off in a range-diff"
    }))
}

/// The pull request a review was entered as, if any.
pub fn pr_url(review: &Review) -> Option<String> {
    match review {
        Review::Range { pr: Some(pr), .. } => Some(pr.url.clone()),
        _ => None,
    }
}

/// Owns the current review and everything derived from it. Every mutation of the active state
/// (entering a review, showing a slice, a refresh, a context change) runs through one queue, one
/// at a time, in request order, on its own task, so a caller that goes away never leaves a
/// transition half done. Snapshot versions are allocated only inside the queue, so published
/// versions are monotonic. Requests that arrive before the first review resolves wait on `ready`.
///
/// A worktree-live review recomputes on every change. A refs-live one only announces that its
/// refs moved (`moved`) and recomputes on `reload`, so a push or rebase does not swap the review
/// out from under the reviewer, unless `follows` says otherwise.
pub struct Session {
    pub repo: Arc<GitRepo>,
    hub: Arc<dyn Broadcaster>,
    watch: bool,
    github: Github,
    /// The latest pull request discovery: its snapshot, when it goes stale, and the shared lookup.
    discovered: Mutex<Option<Discovery>>,
    /// Exports one at a time, so two overlapping ones cannot add the same thread twice.
    exporter: crate::github::review::GithubExporter,
    context: Mutex<u32>,
    follow_refs: Mutex<FollowRefs>,
    version: AtomicI64,
    active: Mutex<Option<Arc<Active>>>,
    jobs: mpsc::UnboundedSender<Job>,
    ready: signal::Sender<Option<Result<()>>>,
    /// The refresh, and the refs check, waiting for the queue, if any. Later requests join them.
    queued_refresh: Mutex<Option<Pending>>,
    queued_check: Mutex<Option<Pending>>,
    listeners: Mutex<Vec<Listener>>,
    readable: Mutex<Option<(Arc<Snapshot>, Arc<ReadablePaths>)>>,
}

impl Session {
    pub fn new(repo: Arc<GitRepo>, hub: Arc<dyn Broadcaster>, opts: SessionOptions) -> Arc<Self> {
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        tokio::spawn(async move {
            while let Some(job) = queue.recv().await {
                job.await;
            }
        });
        Arc::new(Self {
            repo,
            hub,
            watch: opts.watch,
            github: opts.github,
            discovered: Mutex::new(None),
            exporter: crate::github::review::GithubExporter::default(),
            context: Mutex::new(opts.context),
            follow_refs: Mutex::new(opts.follow_refs),
            version: AtomicI64::new(0),
            active: Mutex::new(None),
            jobs,
            ready: signal::channel(None).0,
            queued_refresh: Mutex::new(None),
            queued_check: Mutex::new(None),
            listeners: Mutex::new(Vec::new()),
            readable: Mutex::new(None),
        })
    }

    /// Runs `job` after every earlier one settled, on the queue's task. The only way to change
    /// `active`, `version` or the context.
    fn run<T, F>(&self, job: F) -> impl Future<Output = Result<T>> + Send + use<T, F>
    where
        T: Send + 'static,
        F: Future<Output = Result<T>> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let sent = self.jobs.send(
            async move {
                // A panicking job fails its caller, not the queue.
                let result = std::panic::AssertUnwindSafe(job).catch_unwind().await;
                let _ = tx.send(result.unwrap_or_else(|_| Err(anyhow::anyhow!("session task panicked").into())));
            }
            .boxed(),
        );
        async move {
            sent.map_err(|_| Error::from(anyhow::anyhow!("session closed")))?;
            rx.await.unwrap_or_else(|_| Err(anyhow::anyhow!("session closed").into()))
        }
    }

    /// Resolves once the first review is active; fails with its error if it could not start.
    pub async fn ready(&self) -> Result<()> {
        let mut rx = self.ready.subscribe();
        let state = rx.wait_for(Option::is_some).await.map_err(|_| Error::from(anyhow::anyhow!("session closed")))?;
        state.clone().expect("ready")
    }

    fn active(&self) -> Result<Arc<Active>> {
        self.active.lock().unwrap().clone().ok_or_else(|| anyhow::anyhow!("session not ready").into())
    }

    fn is_active(&self, a: &Arc<Active>) -> bool {
        self.active.lock().unwrap().as_ref().is_some_and(|current| Arc::ptr_eq(current, a))
    }

    pub fn review(&self) -> Result<Review> {
        Ok(self.active()?.review.clone())
    }

    pub fn snapshotter(&self) -> Result<Arc<Snapshotter>> {
        Ok(self.active()?.snapshotter.clone())
    }

    pub fn comments(&self) -> Result<Arc<CommentStore>> {
        Ok(self.active()?.comments.clone())
    }

    /// The pull request the active review was entered as, if any.
    pub fn pr_url(&self) -> Result<Option<String>> {
        Ok(pr_url(&self.active()?.review))
    }

    /// The pending reload of a refs-live range, for a client that connects after the push.
    pub fn moved(&self) -> Result<Option<Moved>> {
        Ok(self.active()?.moved.lock().unwrap().clone())
    }

    pub fn context(&self) -> u32 {
        *self.context.lock().unwrap()
    }

    pub fn github(&self) -> &Github {
        &self.github
    }

    /// Whether moved refs recompute the review, as worktree edits always do, or only announce themselves.
    pub fn follows(&self) -> Result<bool> {
        let a = self.active()?;
        Ok(a.follows == Live::Worktree
            || match *self.follow_refs.lock().unwrap() {
                FollowRefs::On => true,
                FollowRefs::Off => false,
                FollowRefs::Auto => !a.branches,
            })
    }

    /// Change the user's choice for the running session; a pending notice stands until a reload picks the refs up.
    pub fn set_follow_refs(&self, follow_refs: FollowRefs) {
        *self.follow_refs.lock().unwrap() = follow_refs;
    }

    /// Runs after every snapshot the session produces: the first review, a switch, a refresh, a context
    /// change. In-process consumers (the LSP bridge) use this; clients get the `snapshot` broadcast.
    pub fn on_snapshot(&self, listener: impl Fn(&Arc<Snapshot>) + Send + Sync + 'static) {
        self.listeners.lock().unwrap().push(Box::new(listener));
    }

    fn announce(&self, snap: &Arc<Snapshot>) {
        for listener in self.listeners.lock().unwrap().iter() {
            listener(snap);
        }
    }

    /// Allocates the next snapshot version; only queued jobs call it.
    fn next_version(&self) -> i64 {
        self.version.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Waits for every queued transition, then stops watching.
    pub async fn close(self: &Arc<Self>) {
        let _ = self.run(async { Ok(()) }).await;
        let active = self.active.lock().unwrap().clone();
        if let Some(active) = active
            && let Some(watcher) = active.watcher.lock().await.take()
        {
            watcher.close().await;
        }
    }
}
