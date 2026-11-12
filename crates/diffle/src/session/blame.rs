//! Blames of the files a snapshot shows: each side of a file is blamed whole once and kept, and the
//! changed files are blamed ahead in the background, so the cursor's blame is ready when it rests.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};

use super::{Session, side_path};
use crate::concurrency::map_limit;
use crate::error::Result;
use crate::git::{Blame, BlameStart, WORKTREE};
use crate::protocol::{ChangeStatus, Side, Snapshot};

/// Background blames in flight at once, so prefetching leaves the blocking pool to the snapshot work.
const PREFETCH: usize = 2;

type Pending = Shared<BoxFuture<'static, Result<Option<Arc<Blame>>>>>;

/// What one blame starts from: a commit, or the worktree as one snapshot version saw it.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    rev: String,
    path: String,
}

#[derive(Default)]
pub(super) struct BlameCache {
    entries: Mutex<HashMap<Key, Pending>>,
    /// Bumped by every snapshot, which stops the previous one's prefetch.
    generation: AtomicU64,
}

fn rev_key(snap: &Snapshot, side: Side) -> String {
    let rev = if side == Side::New { &snap.new_sha } else { &snap.old_sha };
    // The worktree can change under the same name: its blames last one snapshot.
    if rev == WORKTREE { format!("{WORKTREE}@{}", snap.version) } else { rev.clone() }
}

impl Session {
    /// Blames one side of a snapshot path, resolved through the allowlist as `read_side` resolves it,
    /// over the 1-based inclusive `lines` or all of it. None when the snapshot does not expose it there
    /// or the side has no history.
    pub async fn blame(
        self: &Arc<Self>,
        snap: &Arc<Snapshot>,
        path: &str,
        side: Side,
        lines: Option<(u64, u64)>,
    ) -> Result<Option<Blame>> {
        let whole = self.whole_blame(snap, path, side).await?;
        Ok(whole.map(|b| lines.map_or_else(|| (*b).clone(), |(first, last)| b.lines(first, last))))
    }

    /// All of one side's blame, shared with whoever computed or is computing it.
    async fn whole_blame(self: &Arc<Self>, snap: &Arc<Snapshot>, path: &str, side: Side) -> Result<Option<Arc<Blame>>> {
        let paths = self.readable_paths(snap);
        let Some(target) = side_path(&paths, path, side).map(str::to_owned) else { return Ok(None) };
        let key = Key { rev: rev_key(snap, side), path: target.clone() };
        let pending = {
            let mut entries = self.blames.entries.lock().unwrap();
            entries.entry(key.clone()).or_insert_with(|| compute(self, snap, side, target)).clone()
        };
        let result = pending.clone().await;
        if result.is_err() {
            // A failure is not kept: the next ask tries again.
            let mut entries = self.blames.entries.lock().unwrap();
            if entries.get(&key).is_some_and(|p| p.ptr_eq(&pending)) {
                entries.remove(&key);
            }
        }
        result
    }

    /// Drops the blames `snap` cannot ask for again and blames its changed files ahead, new sides
    /// first, until the next snapshot arrives.
    pub(super) fn prefetch_blames(self: &Arc<Self>, snap: &Arc<Snapshot>) {
        let generation = self.blames.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let revs = [rev_key(snap, Side::New), rev_key(snap, Side::Old)];
        self.blames.entries.lock().unwrap().retain(|k, _| revs.contains(&k.rev));
        let blamable = |f: &&crate::protocol::ChangedFile| !f.binary && f.submodule.is_none();
        let files = snap.changed.iter().filter(blamable);
        let new = files.clone().filter(|f| f.status != ChangeStatus::D).map(|f| (f.path.clone(), Side::New));
        let old = files.filter(|f| f.status != ChangeStatus::A).map(|f| (f.path.clone(), Side::Old));
        let jobs: Vec<_> = new.chain(old).collect();
        let (session, snap) = (Arc::downgrade(self), snap.clone());
        tokio::spawn(async move {
            map_limit(jobs, PREFETCH, |(path, side)| {
                let (session, snap): (Weak<Session>, _) = (session.clone(), snap.clone());
                async move {
                    let Some(session) = session.upgrade() else { return };
                    if session.blames.generation.load(Ordering::SeqCst) == generation {
                        // Only a head start: a failure surfaces when the reviewer asks.
                        let _ = session.whole_blame(&snap, &path, side).await;
                    }
                }
            })
            .await;
        });
    }
}

/// Starts blaming all of `target` on one side of `snap`, driven on its own so a client that goes
/// away does not abandon it half done.
fn compute(session: &Arc<Session>, snap: &Snapshot, side: Side, target: String) -> Pending {
    let repo = session.repo.clone();
    let rev = if side == Side::New { snap.new_sha.clone() } else { snap.old_sha.clone() };
    let job = async move {
        let start = if rev == WORKTREE {
            let Some(buf) = repo.read_worktree(&target).await? else { return Ok(None) };
            BlameStart::Worktree(buf)
        } else {
            BlameStart::Commit(rev)
        };
        Ok(repo.blame(start, &target).await?.map(Arc::new))
    };
    let pending = tokio::spawn(job).map(|joined| joined.unwrap_or_else(|e| Err(anyhow::Error::from(e).into())));
    pending.boxed().shared()
}
