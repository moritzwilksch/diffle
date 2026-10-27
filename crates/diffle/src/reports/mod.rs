//! Reports: documents attached to a snapshot, made by the generators diffle runs for it or pushed
//! over the API by something outside, an agent say. One view in the client shows them all.
pub mod catalog;
mod exec;
mod generated;
pub mod input;
mod pushed;
pub mod runner;
mod sides;
pub mod store;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use sha1::{Digest, Sha1};
use tokio::task::AbortHandle;

use crate::error::{Error, Result};
use crate::protocol::{Report, ReportFile, ReportTarget, ReportsResponse, Snapshot};
use crate::session::{Broadcaster, Session};
use catalog::Plugin;
use runner::Produced;
use store::{ReportStore, Stored};

struct State {
    /// The newest snapshot seen, which generated reports answer for.
    version: i64,
    /// The comment key `pushed` was loaded for.
    key: Option<String>,
    generated: BTreeMap<String, Stored>,
    pushed: BTreeMap<String, Stored>,
    /// Files uploaded for a report not put yet, by id then authored path.
    uploads: HashMap<String, HashMap<String, ReportFile>>,
    /// What each generator wrote to stderr on its last run.
    logs: HashMap<String, Vec<String>>,
}

/// Every report of the active review. Generated ones follow the snapshot: each new one starts
/// the generators whose globs match a changed file, a run still going for an older snapshot is
/// killed, and a result commits only while its snapshot is the newest. Pushed ones persist under
/// the review's comment key and go stale, never away, when the snapshot moves.
pub struct Reports {
    session: Arc<Session>,
    hub: Arc<dyn Broadcaster>,
    store: ReportStore,
    plugins: Vec<Plugin>,
    state: Mutex<State>,
    /// The run in flight per generator.
    runs: Mutex<HashMap<String, AbortHandle>>,
    /// Results by generator and input, so stepping back to a snapshot seen before is instant.
    cache: Mutex<HashMap<String, Arc<Produced>>>,
}

/// The snapshot a report answers for: its endpoints, plus the changed files' blobs so a worktree
/// side that moved on is told apart.
pub fn target_of(snap: &Snapshot) -> ReportTarget {
    let mut hasher = Sha1::new();
    hasher.update(snap.old_sha.as_bytes());
    hasher.update(b"\0");
    hasher.update(snap.new_sha.as_bytes());
    for f in &snap.changed {
        for part in [&f.path, &f.status.to_string(), &f.blob, &f.old_blob] {
            hasher.update(b"\0");
            hasher.update(part.as_bytes());
        }
    }
    ReportTarget {
        old_sha: snap.old_sha.clone(),
        new_sha: snap.new_sha.clone(),
        digest: hex::encode(hasher.finalize()),
    }
}

pub fn same_target(a: &ReportTarget, b: &ReportTarget) -> bool {
    a.old_sha == b.old_sha && a.new_sha == b.new_sha && a.digest == b.digest
}

impl Reports {
    /// Reports for `session`, kept under `git_dir`, with `plugins` run on every snapshot from now on.
    pub fn new(session: Arc<Session>, hub: Arc<dyn Broadcaster>, git_dir: &Path, plugins: Vec<Plugin>) -> Arc<Self> {
        let plugins = plugins
            .into_iter()
            .filter(|p| {
                let ok = input::check_id(&p.name).is_ok();
                if !ok {
                    crate::status!(
                        "[diffle] ignoring plugin \"{}\": a name is lowercase letters, digits and dashes",
                        p.name
                    );
                }
                ok
            })
            .collect();
        let this = Arc::new(Self {
            session: session.clone(),
            hub,
            store: ReportStore::new(git_dir),
            plugins,
            state: Mutex::new(State {
                version: 0,
                key: None,
                generated: BTreeMap::new(),
                pushed: BTreeMap::new(),
                uploads: HashMap::new(),
                logs: HashMap::new(),
            }),
            runs: Mutex::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
        });
        let weak: Weak<Self> = Arc::downgrade(&this);
        session.on_snapshot(move |snap| {
            if let Some(reports) = weak.upgrade() {
                let snap = snap.clone();
                tokio::spawn(async move { reports.sync(snap).await });
            }
        });
        this
    }

    pub fn plugins(&self) -> &[Plugin] {
        &self.plugins
    }

    /// The current snapshot and its target; the pushed reports are loaded for its key first.
    async fn current(&self) -> Result<(Arc<Snapshot>, ReportTarget)> {
        let snap = self.session.snapshotter()?.current().await?;
        self.load_pushed(&snap).await?;
        let target = target_of(&snap);
        Ok((snap, target))
    }

    async fn load_pushed(&self, snap: &Snapshot) -> Result<()> {
        if self.state.lock().unwrap().key.as_deref() == Some(&snap.comment_key) {
            return Ok(());
        }
        let pushed = self.store.load(&snap.comment_key).await?;
        let mut state = self.state.lock().unwrap();
        state.key = Some(snap.comment_key.clone());
        state.pushed = pushed.into_iter().map(|r| (r.id.clone(), r)).collect();
        Ok(())
    }

    fn served(stored: &Stored, current: &ReportTarget) -> Report {
        Report {
            id: stored.id.clone(),
            source: stored.source,
            title: stored.title.clone(),
            summary: stored.summary.clone(),
            target: stored.target.clone(),
            status: stored.status,
            error: stored.error.clone(),
            stale: !same_target(&stored.target, current),
            updated_at: stored.updated_at,
            blocks: stored.blocks.clone(),
        }
    }

    pub async fn list(&self) -> Result<ReportsResponse> {
        let (_, current) = self.current().await?;
        let state = self.state.lock().unwrap();
        let reports =
            state.generated.values().chain(state.pushed.values()).map(|r| Self::served(r, &current)).collect();
        Ok(ReportsResponse { current, reports })
    }

    pub async fn current_target(&self) -> Result<ReportTarget> {
        Ok(self.current().await?.1)
    }

    pub async fn get(&self, id: &str) -> Result<Report> {
        let (_, current) = self.current().await?;
        let state = self.state.lock().unwrap();
        let stored =
            state.generated.get(id).or_else(|| state.pushed.get(id)).ok_or_else(|| Error::NotFound(id.into()))?;
        Ok(Self::served(stored, &current))
    }

    /// What the report's maker wrote to stderr, or what validation dropped.
    pub fn log(&self, id: &str) -> Result<Vec<String>> {
        let state = self.state.lock().unwrap();
        if !state.generated.contains_key(id) && !state.pushed.contains_key(id) {
            return Err(Error::NotFound(id.into()));
        }
        Ok(state.logs.get(id).cloned().unwrap_or_default())
    }

    /// The bytes report `id` names under `key`, or none: a key the report does not name serves nothing.
    pub async fn file(&self, id: &str, key: &str) -> Result<Option<(Vec<u8>, &'static str)>> {
        let named = {
            let state = self.state.lock().unwrap();
            let report = state.generated.get(id).or_else(|| state.pushed.get(id));
            report.is_some_and(|r| r.keys().any(|k| k == key))
        };
        if !named {
            return Ok(None);
        }
        self.store.read_blob(key).await
    }

    /// Drops blobs nothing names any more; a failure here costs disk, not correctness.
    async fn sweep(&self) {
        let keep: HashSet<String> = {
            let state = self.state.lock().unwrap();
            let kept = state.generated.values().chain(state.pushed.values()).flat_map(Stored::keys).map(str::to_owned);
            kept.chain(state.uploads.values().flatten().map(|(_, f)| f.key.clone())).collect()
        };
        if let Err(e) = self.store.sweep(&keep, runner::RUN_TIMEOUT).await {
            crate::status!("[diffle] sweeping report files: {e:#}");
        }
    }
}

fn block_keys(block: &crate::protocol::ReportBlock) -> Vec<&str> {
    match block {
        crate::protocol::ReportBlock::Markdown { .. } => Vec::new(),
        crate::protocol::ReportBlock::Pages { pages, .. } => {
            pages.iter().flat_map(|p| [p.old.as_ref(), p.new.as_ref()]).flatten().map(|f| f.key.as_str()).collect()
        }
    }
}
