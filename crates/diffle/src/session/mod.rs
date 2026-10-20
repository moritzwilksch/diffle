//! The active mode and everything derived from it, behind one serialized transition queue.
mod files;
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
use crate::github::hosts::GithubInstance;
use crate::iterations::IterationStore;
use crate::mode::resolve::{names_branch, resolve_review};
use crate::protocol::{
    Comparison, ComparisonBase, FollowRefs, Live, ModeRequest, ModeSpec, Moved, ServerMessage, Snapshot,
};
use crate::snapshotter::Snapshotter;
use crate::watcher::Watcher;

pub use files::{ReadablePaths, side_path};

/// The range a mode belongs to: its `within`, or the mode itself.
fn range_of(mode: &ModeSpec) -> Comparison {
    mode.within.clone().unwrap_or_else(|| Comparison {
        old: mode.old.clone(),
        new: mode.new.clone(),
        base: mode.base,
        live: mode.live,
        comment_key: mode.comment_key.clone(),
    })
}

/// Where clients hear about state changes: the WebSocket hub, or a recorder in tests.
pub trait Broadcaster: Send + Sync {
    fn broadcast(&self, msg: ServerMessage);
}

/// A review ready to activate: the comparison, and the pull request it was entered as, if any.
#[derive(Clone, Debug)]
pub struct ResolvedReview {
    pub mode: ModeSpec,
    pub pr_url: Option<String>,
}

pub struct SessionOptions {
    pub watch: bool,
    /// Where GitHub is; decides comment keys of ranges on its remotes.
    pub instance: GithubInstance,
    /// Context lines for patches: `--context`, else the user config. Changed at runtime via `set_context`.
    pub context: u32,
    /// What a review between refs does when one moves. The user config; `set_follow_refs` changes it.
    pub follow_refs: FollowRefs,
}

struct Active {
    mode: ModeSpec,
    pr_url: Option<String>,
    snapshotter: Arc<Snapshotter>,
    comments: Arc<CommentStore>,
    watcher: tokio::sync::Mutex<Option<Watcher>>,
    /// Where a refs-live comparison's refs point now, when that differs from the snapshot; cleared by a reload.
    moved: Mutex<Option<Moved>>,
    /// Whether an endpoint of the followed range names a branch; decides what `auto` does with a move.
    branches: bool,
}

type Job = BoxFuture<'static, ()>;
type Listener = Box<dyn Fn(&Arc<Snapshot>) + Send + Sync>;
type Pending = Shared<BoxFuture<'static, ()>>;

/// Owns the current mode and everything derived from it. Every mutation of the active state (mode
/// transition, refresh, context change) runs through one queue, one at a time, in request order,
/// on its own task, so a caller that goes away never leaves a transition half done. Snapshot
/// versions are allocated only inside the queue, so published versions are monotonic. Requests
/// that arrive before the first mode resolves wait on `ready`.
///
/// A worktree-live comparison recomputes on every change. A refs-live one only announces that its
/// refs moved (`moved`) and recomputes on `reload`, so a push or rebase does not swap the review
/// out from under the reviewer, unless `follows` says otherwise.
pub struct Session {
    pub repo: Arc<GitRepo>,
    hub: Arc<dyn Broadcaster>,
    watch: bool,
    instance: GithubInstance,
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
            instance: opts.instance,
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

    /// Resolves once the first mode is active; fails with its error if it could not start.
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

    pub fn mode(&self) -> Result<ModeSpec> {
        Ok(self.active()?.mode.clone())
    }

    pub fn snapshotter(&self) -> Result<Arc<Snapshotter>> {
        Ok(self.active()?.snapshotter.clone())
    }

    pub fn comments(&self) -> Result<Arc<CommentStore>> {
        Ok(self.active()?.comments.clone())
    }

    /// The pull request the active review was entered as, if any.
    pub fn pr_url(&self) -> Result<Option<String>> {
        Ok(self.active()?.pr_url.clone())
    }

    /// The pending reload of a refs-live comparison, for a client that connects after the push.
    pub fn moved(&self) -> Result<Option<Moved>> {
        Ok(self.active()?.moved.lock().unwrap().clone())
    }

    pub fn context(&self) -> u32 {
        *self.context.lock().unwrap()
    }

    pub fn instance(&self) -> &GithubInstance {
        &self.instance
    }

    /// Whether moved refs recompute the review, as worktree edits always do, or only announce themselves.
    pub fn follows(&self) -> Result<bool> {
        let a = self.active()?;
        Ok(a.mode.live == Live::Worktree
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

    /// Runs after every snapshot the session produces: the first mode, a switch, a refresh, a context
    /// change. In-process consumers (the LSP bridge) use this; clients get the `snapshot` broadcast.
    pub fn on_snapshot(&self, listener: impl Fn(&Arc<Snapshot>) + Send + Sync + 'static) {
        self.listeners.lock().unwrap().push(Box::new(listener));
    }

    fn announce(&self, snap: &Arc<Snapshot>) {
        for listener in self.listeners.lock().unwrap().iter() {
            listener(snap);
        }
    }

    /// Resolves a request into a review without activating it, so a caller can reject invalid input
    /// before serving. Queued, so `close` waits for it.
    pub fn resolve(self: &Arc<Self>, req: ModeRequest) -> impl Future<Output = Result<ResolvedReview>> + Send + use<> {
        let this = self.clone();
        self.run(async move {
            let mode = resolve_review(&req, &this.repo, &this.instance).await?;
            Ok(ResolvedReview { mode, pr_url: None })
        })
    }

    /// First mode, from `resolve`. Fails `ready` too, so early requests error out.
    pub async fn start(self: &Arc<Self>, review: ResolvedReview) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        let result = self.run(async move { this.activate(review).await }).await;
        self.ready.send_replace(Some(result.as_ref().map(|_| ()).map_err(Clone::clone)));
        result
    }

    /// Switch modes at runtime. Broadcasts a snapshot bump on success.
    pub async fn switch_mode(self: &Arc<Self>, req: ModeRequest) -> Result<Arc<Snapshot>> {
        let this = self.clone();
        let snap = self
            .run(async move {
                let review = match req {
                    ModeRequest::Focus { commit } => this.focus(commit).await?,
                    ModeRequest::Interdiff { from, to } => this.interdiff(from.get() as i64, to.get() as i64).await?,
                    ModeRequest::Pair { commit } => this.pair(commit).await?,
                    req => {
                        ResolvedReview { mode: resolve_review(&req, &this.repo, &this.instance).await?, pr_url: None }
                    }
                };
                this.activate(review).await
            })
            .await?;
        self.hub.broadcast(ServerMessage::Snapshot { version: snap.version });
        Ok(snap)
    }

    async fn activate(self: &Arc<Self>, ResolvedReview { mode, pr_url }: ResolvedReview) -> Result<Arc<Snapshot>> {
        // A range that can move again gets its iterations recorded: one between refs, or a PR's, fetched anew each run.
        let range = range_of(&mode);
        let followed = range.base != ComparisonBase::Parent && (range.live == Live::Refs || pr_url.is_some());
        let version = self.next_version();
        let iterations = followed.then(|| IterationStore::new(self.repo.clone(), range.comment_key.clone()));
        let snapshotter = Snapshotter::new(self.repo.clone(), mode.clone(), version, self.context(), iterations);
        let branches = async {
            if range.live == Live::Refs { names_branch(&self.repo, &range.old, &range.new).await } else { Ok(false) }
        };
        let (comments, snap, branches) = tokio::try_join!(
            CommentStore::open(&self.repo.git_dir, &mode.comment_key),
            snapshotter.current(),
            branches
        )?;
        let next = Arc::new(Active {
            mode,
            pr_url,
            snapshotter,
            comments: Arc::new(comments),
            watcher: tokio::sync::Mutex::new(None),
            moved: Mutex::new(None),
            branches,
        });
        // The repository may have moved on while no server was watching it.
        self.relocate_comments(&next, &snap).await?;
        if self.watch && next.mode.live != Live::None {
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
