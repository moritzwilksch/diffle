//! What the graph asks of the world: patches, outlines and references. `PoolSource` is the only
//! place that touches the language-server pool; tests stand in with an in-memory source.
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use super::changed::{edits, edits_by_file};
use super::moved::Edits;
use crate::error::{Error, Result};
use crate::lsp::pool::LspPool;
use crate::protocol::{
    LspFeature, LspLocationsResponse, LspPosition, LspQuery, LspStatus, LspSymbolsResponse, Snapshot, follows_checkout,
    lsp_blocker,
};
use crate::snapshotter::Snapshotter;

/// Why an outline or a reference query fails when the run has no pool.
const SERVERS_OFF: &str = "language servers are off";

/// The facts one snapshot's graph is built from.
pub trait SymbolSource: Sync {
    /// Gets the servers for the diff going. Call before `unavailable`: a pool starts them lazily.
    fn prepare(&self) -> impl Future<Output = ()> + Send;

    /// Why no file of this snapshot can be graphed (servers off, the new side is not the checkout,
    /// no server for the diff), or none.
    fn unavailable(&self) -> Option<String>;

    /// Why files of `path`'s language cannot be graphed, or none. The answer is the language's,
    /// so a caller asks once per language.
    fn blocker(&self, path: &str) -> Option<String>;

    /// What each of `paths` changes, as line fingerprints and new-side line numbers. A path missing
    /// from the answer is not changed any more. Only these are kept, never the patches.
    fn edits(&self, paths: &[&str]) -> impl Future<Output = Result<HashMap<String, Edits>>> + Send;

    fn outline(&self, path: &str) -> impl Future<Output = Result<LspSymbolsResponse>> + Send;

    fn references(&self, at: &LspPosition) -> impl Future<Output = Result<LspLocationsResponse>> + Send;

    /// Whether a server reports background work, so an empty answer may be a premature one.
    fn busy(&self) -> bool;
}

/// The run's language servers and patches, read for one snapshot. `pool` is none with `--no-lsp`.
pub struct PoolSource {
    pool: Option<Arc<LspPool>>,
    snapshotter: Arc<Snapshotter>,
    snap: Arc<Snapshot>,
}

impl PoolSource {
    pub fn new(pool: Option<Arc<LspPool>>, snapshotter: Arc<Snapshotter>, snap: Arc<Snapshot>) -> Self {
        Self { pool, snapshotter, snap }
    }

    fn status(&self) -> LspStatus {
        self.pool
            .as_ref()
            .map_or_else(|| LspStatus { enabled: false, servers: Vec::new(), missing: Vec::new() }, |p| p.status())
    }

    /// Patient: a starting server is waited for, not refused.
    fn blocked(&self, path: Option<&str>) -> Option<String> {
        let query = LspQuery { path, feature: Some(LspFeature::DocumentSymbol), patient: true };
        lsp_blocker(&self.status(), follows_checkout(&self.snap), &query)
    }
}

impl SymbolSource for PoolSource {
    async fn prepare(&self) {
        let Some(pool) = &self.pool else { return };
        // The session tracks every snapshot it takes; this only catches a first request that beat
        // that to a pool with nothing started, and never re-tracks a snapshot a newer one replaced.
        let current = self.snapshotter.current().await.is_ok_and(|c| Arc::ptr_eq(&c, &self.snap));
        if should_track(current, pool.status().servers.is_empty()) {
            pool.track(&self.snap).await;
        }
    }

    fn unavailable(&self) -> Option<String> {
        self.blocked(None)
    }

    fn blocker(&self, path: &str) -> Option<String> {
        self.blocked(Some(path))
    }

    async fn edits(&self, paths: &[&str]) -> Result<HashMap<String, Edits>> {
        let wanted: HashSet<&str> = paths.iter().copied().collect();
        let owned: Vec<String> = paths.iter().map(|p| (*p).to_owned()).collect();
        let mut found = edits_by_file(&self.snapshotter.patches_of(&self.snap, &owned).await?);
        found.retain(|path, _| wanted.contains(path.as_str()));
        // A file the headers did not name plainly: its patch alone is unambiguous.
        let unnamed: Vec<&String> = owned.iter().filter(|p| !found.contains_key(*p)).collect();
        for path in unnamed {
            let alone = self.snapshotter.patches_of(&self.snap, std::slice::from_ref(path)).await?;
            if !alone.is_empty() {
                found.insert(path.clone(), edits(&alone));
            }
        }
        Ok(found)
    }

    async fn outline(&self, path: &str) -> Result<LspSymbolsResponse> {
        match &self.pool {
            Some(pool) => pool.document_symbols(path).await,
            None => Err(Error::LspUnavailable(SERVERS_OFF.into())),
        }
    }

    async fn references(&self, at: &LspPosition) -> Result<LspLocationsResponse> {
        match &self.pool {
            Some(pool) => pool.references(at).await,
            None => Err(Error::LspUnavailable(SERVERS_OFF.into())),
        }
    }

    fn busy(&self) -> bool {
        self.status().servers.iter().any(|s| !s.activity.is_empty())
    }
}

/// Whether the first request should start the servers for its snapshot.
fn should_track(snapshot_is_current: bool, pool_is_idle: bool) -> bool {
    snapshot_is_current && pool_is_idle
}

#[cfg(test)]
mod tests {
    use super::should_track;

    #[test]
    fn the_first_request_starts_servers_only_for_the_current_snapshot_and_an_idle_pool() {
        let table = [(true, true, true), (true, false, false), (false, true, false), (false, false, false)];
        for (current, idle, want) in table {
            assert_eq!(should_track(current, idle), want, "current {current}, idle {idle}");
        }
    }
}

/// An in-memory source for the collector's and the settle step's tests.
#[cfg(test)]
pub(crate) mod fake {
    use std::collections::{HashMap, VecDeque};
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;
    use crate::protocol::{LspLocation, LspSymbol};

    /// What one `references` call answers; replies queue per (path, line), and an empty queue
    /// answers with no locations.
    pub enum Reply {
        Found(Vec<LspLocation>),
        Inconclusive,
        Unavailable(&'static str),
        /// Any other failure: a timeout, a refused request.
        Fail(Error),
    }

    /// What one `outline` call answers before the file's static outline takes over.
    pub enum OutlineReply {
        /// Empty and flagged as inconclusive: the server was still working.
        Busy,
        Fail(Error),
    }

    #[derive(Default)]
    pub struct Fake {
        pub patches: HashMap<String, String>,
        /// `Err` is the message of an `LspUnavailable`.
        pub outlines: HashMap<String, std::result::Result<Vec<LspSymbol>, String>>,
        /// Queued per path, ahead of `outlines`.
        pub outline_replies: Mutex<HashMap<String, VecDeque<OutlineReply>>>,
        /// Every path `outline` was asked for, in order.
        pub outlined: Mutex<Vec<String>>,
        pub replies: Mutex<HashMap<(String, i64), VecDeque<Reply>>>,
        /// Every (path, line) `references` was asked at, in order.
        pub asked: Mutex<Vec<(String, u64)>>,
        /// `busy` answers true this many more times.
        pub busy_for: AtomicUsize,
        pub polls: AtomicUsize,
        pub blocked: HashMap<String, String>,
        /// How many paths each `edits` call was given.
        pub batches: Mutex<Vec<usize>>,
        /// How often `blocker` was asked.
        pub blocker_calls: AtomicUsize,
        /// Every `references` call takes this long.
        pub delay: std::time::Duration,
        pub off: Option<String>,
    }

    impl Fake {
        /// A changed file whose patch touches `lines` and whose outline is `symbols`.
        pub fn file(mut self, path: &str, lines: &[u32], symbols: Vec<LspSymbol>) -> Self {
            let patch: String = lines.iter().map(|l| format!("@@ -1,0 +{l},1 @@\n+x\n")).collect();
            self.patches.insert(path.into(), patch);
            self.outlines.insert(path.into(), Ok(symbols));
            self
        }

        /// A changed file with this very patch, for edits a line list cannot say (what was removed, and its text).
        pub fn patched(mut self, path: &str, patch: &str, symbols: Vec<LspSymbol>) -> Self {
            self.patches.insert(path.into(), patch.into());
            self.outlines.insert(path.into(), Ok(symbols));
            self
        }

        pub fn replies(self, path: &str, line: i64, replies: Vec<Reply>) -> Self {
            self.replies.lock().unwrap().insert((path.into(), line), replies.into());
            self
        }

        pub fn outline_replies(self, path: &str, replies: Vec<OutlineReply>) -> Self {
            self.outline_replies.lock().unwrap().insert(path.into(), replies.into());
            self
        }

        pub fn outlined_count(&self, path: &str) -> usize {
            self.outlined.lock().unwrap().iter().filter(|p| *p == path).count()
        }

        pub fn asked_at(&self, path: &str, line: u64) -> usize {
            self.asked.lock().unwrap().iter().filter(|(p, l)| p == path && *l == line).count()
        }
    }

    pub fn sym(path: &str, name: &str, kind: i64, line: i64, end_line: i64) -> LspSymbol {
        LspSymbol { name: name.into(), kind, container: None, path: path.into(), line, end_line, col: 4 }
    }

    pub fn loc(path: &str, line: u64) -> LspLocation {
        serde_json::from_value(json!({ "path": path, "line": line, "col": 0, "text": "" })).unwrap()
    }

    pub fn external(path: &str, line: u64) -> LspLocation {
        serde_json::from_value(json!({ "path": path, "line": line, "col": 0, "text": "", "external": true })).unwrap()
    }

    impl SymbolSource for Fake {
        async fn prepare(&self) {}

        fn unavailable(&self) -> Option<String> {
            self.off.clone()
        }

        fn blocker(&self, path: &str) -> Option<String> {
            self.blocker_calls.fetch_add(1, Ordering::SeqCst);
            self.blocked.get(path).cloned()
        }

        async fn edits(&self, paths: &[&str]) -> Result<HashMap<String, Edits>> {
            self.batches.lock().unwrap().push(paths.len());
            Ok(paths.iter().filter_map(|p| Some(((*p).to_owned(), edits(self.patches.get(*p)?)))).collect())
        }

        async fn outline(&self, path: &str) -> Result<LspSymbolsResponse> {
            self.outlined.lock().unwrap().push(path.into());
            let queued = self.outline_replies.lock().unwrap().get_mut(path).and_then(VecDeque::pop_front);
            match queued {
                Some(OutlineReply::Busy) => {
                    return Ok(LspSymbolsResponse { symbols: Vec::new(), inconclusive: Some("indexing".into()) });
                }
                Some(OutlineReply::Fail(e)) => return Err(e),
                None => {}
            }
            match self.outlines.get(path) {
                Some(Ok(symbols)) => Ok(LspSymbolsResponse { symbols: symbols.clone(), inconclusive: None }),
                Some(Err(m)) => Err(Error::LspUnavailable(m.clone())),
                None => Err(Error::Invalid(format!("{path} has no outline"))),
            }
        }

        async fn references(&self, at: &LspPosition) -> Result<LspLocationsResponse> {
            self.asked.lock().unwrap().push((at.path.to_string(), at.line.get()));
            tokio::time::sleep(self.delay).await;
            let key = (at.path.to_string(), at.line.get() as i64);
            let reply = self.replies.lock().unwrap().get_mut(&key).and_then(VecDeque::pop_front);
            match reply {
                None => Ok(LspLocationsResponse { locations: Vec::new(), inconclusive: None }),
                Some(Reply::Found(locations)) => Ok(LspLocationsResponse { locations, inconclusive: None }),
                Some(Reply::Inconclusive) => {
                    Ok(LspLocationsResponse { locations: Vec::new(), inconclusive: Some("indexing".into()) })
                }
                Some(Reply::Unavailable(m)) => Err(Error::LspUnavailable(m.into())),
                Some(Reply::Fail(e)) => Err(e),
            }
        }

        fn busy(&self) -> bool {
            self.polls.fetch_add(1, Ordering::SeqCst);
            self.busy_for.try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok()
        }
    }
}
