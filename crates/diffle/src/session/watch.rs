//! Watching what the active comparison follows: the worktree, or only its refs.
use std::collections::HashSet;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use super::{Active, Session};
use crate::error::Result;
use crate::protocol::Live;
use crate::watcher::{WatchTarget, Watcher};

/// How long changes settle before one refresh: an editor's save or a checkout is a burst of events.
const DEBOUNCE: Duration = Duration::from_millis(150);

type Ignored = Arc<Mutex<Arc<HashSet<String>>>>;

impl Session {
    pub(super) async fn start_watcher(self: &Arc<Self>, a: &Arc<Active>) -> Result<Watcher> {
        let repo = &self.repo;
        let (session, active) = (Arc::downgrade(self), Arc::downgrade(a));
        if a.follows != Live::Worktree {
            let target = WatchTarget::Refs { git_dir: repo.git_dir.clone(), common_dir: repo.common_dir.clone() };
            return Ok(Watcher::start(target, DEBOUNCE, move || on_dirty(&session, &active, None)).await?);
        }
        let ignored: Ignored = Arc::default();
        refresh_ignored(self, &ignored).await?;
        let read = ignored.clone();
        let target = WatchTarget::Worktree {
            root: repo.root.clone(),
            git_dir: repo.git_dir.clone(),
            common_dir: repo.common_dir.clone(),
            ignored: Arc::new(move || read.lock().unwrap().clone()),
        };
        Ok(Watcher::start(target, DEBOUNCE, move || on_dirty(&session, &active, Some(&ignored))).await?)
    }
}

async fn refresh_ignored(session: &Session, ignored: &Ignored) -> Result<()> {
    let paths: HashSet<String> = session.repo.ignored_paths().await?.into_iter().collect();
    *ignored.lock().unwrap() = Arc::new(paths);
    Ok(())
}

/// A change settled: recompute a followed review, or only tell clients that its refs moved.
fn on_dirty(session: &Weak<Session>, active: &Weak<Active>, ignored: Option<&Ignored>) {
    let (Some(session), Some(a)) = (session.upgrade(), active.upgrade()) else { return };
    if !session.is_active(&a) {
        return;
    }
    if !session.follows().unwrap_or(false) {
        drop(session.check_moved(a));
        return;
    }
    drop(session.refresh());
    let Some(ignored) = ignored.cloned() else { return };
    // Queued behind the refresh, so `close` waits for its git process too.
    let this = session.clone();
    let follow_up =
        session.run(async move { if this.is_active(&a) { refresh_ignored(&this, &ignored).await } else { Ok(()) } });
    tokio::spawn(async move {
        if let Err(e) = follow_up.await {
            crate::status!("[diffle] ignored paths refresh failed: {e}");
        }
    });
}
