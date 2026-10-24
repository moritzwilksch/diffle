//! Watching what the active comparison follows: the worktree, or only its refs.
use std::collections::HashSet;
use std::io::ErrorKind::NotFound;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use super::{Active, Session};
use crate::error::Result;
use crate::protocol::Live;
use crate::watcher::{Dirty, WatchTarget, Watcher};

/// How long changes settle before one refresh: an editor's save or a checkout is a burst of events.
const DEBOUNCE: Duration = Duration::from_millis(150);

type Ignored = Arc<Mutex<Arc<HashSet<String>>>>;

impl Session {
    pub(super) async fn start_watcher(self: &Arc<Self>, a: &Arc<Active>) -> Result<Watcher> {
        let repo = &self.repo;
        let (session, active) = (Arc::downgrade(self), Arc::downgrade(a));
        if a.follows != Live::Worktree {
            let target = WatchTarget::Refs { git_dir: repo.git_dir.clone(), common_dir: repo.common_dir.clone() };
            return Ok(Watcher::start(target, DEBOUNCE, move |_| on_dirty(&session, &active, None)).await?);
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
        Ok(Watcher::start(target, DEBOUNCE, move |dirty| on_worktree_dirty(&session, &active, &ignored, dirty)).await?)
    }
}

async fn refresh_ignored(session: &Session, ignored: &Ignored) -> Result<()> {
    let paths: HashSet<String> = session.repo.ignored_paths().await?.into_iter().collect();
    *ignored.lock().unwrap() = Arc::new(paths);
    Ok(())
}

/// Worktree paths settled: refresh unless none of them can change the review. The watcher's ignored
/// paths predate new files, so without this a build writing fresh artifacts refreshes on each burst.
fn on_worktree_dirty(session: &Weak<Session>, active: &Weak<Active>, ignored: &Ignored, dirty: Dirty) {
    let Dirty::Paths(paths) = dirty else { return on_dirty(session, active, Some(ignored)) };
    let (Some(this), Some(a)) = (session.upgrade(), active.upgrade()) else { return };
    let (session, active, ignored) = (session.clone(), active.clone(), ignored.clone());
    tokio::spawn(async move {
        let Some(rel) = relative(&this.repo.root, &paths) else { return on_dirty(&session, &active, Some(&ignored)) };
        let (matched, snap) = tokio::join!(this.repo.ignored(&rel), a.snapshotter.current());
        let (Ok(matched), Ok(snap)) = (matched, snap) else { return on_dirty(&session, &active, Some(&ignored)) };
        for (path, abs) in rel.iter().zip(&paths) {
            // A path the review lists is reviewable whatever the ignore rules say.
            if snap.tree.binary_search(path).is_ok() {
                return on_dirty(&session, &active, Some(&ignored));
            }
            // A temporary file that came and went (an archiver's, an editor's) left nothing to review.
            if !matched.contains(path)
                && !matches!(tokio::fs::symlink_metadata(abs).await, Err(e) if e.kind() == NotFound)
            {
                return on_dirty(&session, &active, Some(&ignored));
            }
        }
        // Remembered, so later events on these paths stop at the watcher.
        let mut known = ignored.lock().unwrap();
        *known = Arc::new(known.iter().cloned().chain(matched).collect());
    });
}

/// Repo-relative, slash-separated paths; none when one is the root itself or outside it.
fn relative(root: &std::path::Path, paths: &[PathBuf]) -> Option<Vec<String>> {
    paths
        .iter()
        .map(|p| {
            let rel = p.strip_prefix(root).ok().filter(|r| !r.as_os_str().is_empty())?;
            Some(rel.to_string_lossy().replace('\\', "/"))
        })
        .collect()
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
