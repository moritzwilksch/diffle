//! The language servers of one run: started as snapshots name their languages, asked like an editor.
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use indexmap::IndexMap;

use super::documents::{Origin, ReadFn};
use super::locator::HasFn;
use super::merge::{merge_hovers, merge_locations, union};
use super::pool_server::{PathsByLanguage, PoolServer, ServerOptions, paths_of};
use super::registry::{Lookup, resolve_servers};
use crate::error::{Error, Result};
use crate::protocol::{
    ChangeStatus, LanguageId, LspHoverResponse, LspLocationsResponse, LspLogEntry, LspMissing, LspOccurrencesResponse,
    LspPosition, LspStatus, LspSymbolsResponse, Snapshot, follows_checkout, fuzzy_rank, language_of,
};

/// A status change goes out at once when the pool has been quiet, and later ones within this
/// window ride on one trailing publish: a server logging a hundred stderr lines while indexing is a
/// few broadcasts, not a hundred.
const PUBLISH_WINDOW: Duration = Duration::from_millis(20);
/// Workspace symbols one search answers with, ranked before the cap.
const SYMBOL_LIMIT: usize = 200;

/// The location queries, asked of every server for a file alike.
#[derive(Clone, Copy)]
enum Locate {
    Definition,
    TypeDefinition,
    References,
}

pub struct PoolOptions {
    /// Repository root; every server's workspace folder and cwd.
    pub root: std::path::PathBuf,
    pub read: ReadFn,
    pub has: HasFn,
    /// The whole pool's status, coalesced.
    pub on_status: Arc<dyn Fn(LspStatus) + Send + Sync>,
    /// Command per language, replacing the built-in candidates. `""` turns the language off.
    pub overrides: HashMap<LanguageId, String>,
    /// Languages to start a server for at once, whatever the diff holds: the ones named on the command line.
    pub preload: Vec<LanguageId>,
    pub lookup: Lookup,
    pub max_open: Option<usize>,
}

#[derive(Default)]
struct Publish {
    pending: bool,
    due: bool,
}

/// Routes like an editor: every server for a file's language is asked at once and their hovers,
/// definitions and references merged, owner first; highlights and outlines come from the owner
/// alone. Repository-wide queries fan out to all servers, and all of them report as one status.
pub struct LspPool {
    opts: PoolOptions,
    /// Servers by command line: languages resolving to one command share its process.
    entries: Mutex<IndexMap<String, Arc<PoolServer>>>,
    missing: Mutex<Vec<LspMissing>>,
    /// Languages already resolved, served or not, so the PATH probe runs once each.
    resolved: Mutex<HashSet<LanguageId>>,
    closing: AtomicBool,
    publish: Mutex<Publish>,
}

impl LspPool {
    pub fn new(opts: PoolOptions) -> Arc<Self> {
        let preload: PathsByLanguage = opts.preload.iter().map(|l| (*l, Vec::new())).collect();
        let pool = Arc::new(Self {
            opts,
            entries: Mutex::default(),
            missing: Mutex::default(),
            resolved: Mutex::default(),
            closing: AtomicBool::new(false),
            publish: Mutex::default(),
        });
        pool.ensure(&preload);
        pool
    }

    pub fn status(&self) -> LspStatus {
        let servers = self.servers().iter().map(|s| s.status()).collect();
        LspStatus { enabled: true, servers, missing: self.missing.lock().unwrap().clone() }
    }

    fn servers(&self) -> Vec<Arc<PoolServer>> {
        self.entries.lock().unwrap().values().cloned().collect()
    }

    /// The server started by `command`, if one was.
    pub fn server(&self, command: &str) -> Option<Arc<PoolServer>> {
        self.entries.lock().unwrap().get(command).cloned()
    }

    /// The retained log lines of the server started by `command`, or none when none was.
    pub fn log(&self, command: &str) -> Option<Vec<LspLogEntry>> {
        self.entries.lock().unwrap().get(command).map(|s| s.bridge.entries())
    }

    /// Reads an external file only if a running server named it.
    pub async fn read_external(&self, path: &str) -> Option<Vec<u8>> {
        for server in self.servers() {
            if let Some(contents) = server.bridge.read_external(path).await {
                return Some(contents);
            }
        }
        None
    }

    /// Whether a running server may be asked about `path`, a file outside the snapshot: one of its
    /// results named it.
    pub fn named(&self, path: &str) -> bool {
        self.servers().iter().any(|s| matches!(s.bridge.origin(path), Some(Origin::External { .. })))
    }

    pub async fn definition(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        self.locations(pos, Locate::Definition).await
    }

    pub async fn type_definition(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        self.locations(pos, Locate::TypeDefinition).await
    }

    pub async fn references(&self, pos: &LspPosition) -> Result<LspLocationsResponse> {
        self.locations(pos, Locate::References).await
    }

    pub async fn hover(&self, pos: &LspPosition) -> Result<LspHoverResponse> {
        let servers = self.servers_for(&pos.path)?;
        let asked = servers.iter().map(|s| s.bridge.hover(pos).boxed()).collect();
        union(asked, merge_hovers, |r: &LspHoverResponse| r.contents.is_none(), |r| &mut r.inconclusive).await
    }

    pub async fn occurrences(&self, pos: &LspPosition) -> Result<LspOccurrencesResponse> {
        self.owner_for(&pos.path)?.bridge.occurrences(pos).await
    }

    pub async fn document_symbols(&self, path: &str) -> Result<LspSymbolsResponse> {
        self.owner_for(path)?.bridge.document_symbols(path).await
    }

    /// Symbols matching `query` from every running server, best fuzzy match first. Ranked before
    /// the cap: servers list loose matches in their own order.
    pub async fn workspace_symbols(&self, query: &str) -> Result<LspSymbolsResponse> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(Error::LspUnavailable("the language servers are shutting down".into()));
        }
        let servers = self.servers();
        if servers.is_empty() {
            return Err(Error::LspUnavailable("no language server is running".into()));
        }
        let asked = servers.iter().map(|s| s.bridge.workspace_symbols(query).boxed()).collect();
        let merge = |answers: Vec<LspSymbolsResponse>| {
            let all: Vec<_> = answers.into_iter().flat_map(|a| a.symbols).collect();
            let mut symbols = fuzzy_rank(&all, query, |s| s.name.as_str());
            symbols.truncate(SYMBOL_LIMIT);
            LspSymbolsResponse { symbols, inconclusive: None }
        };
        union(asked, merge, |r: &LspSymbolsResponse| r.symbols.is_empty(), |r| &mut r.inconclusive).await
    }

    /// Keeps the diff's files open in every server for their language, starting one for each
    /// language the diff has newly grown. A server whose language left the diff stays up with
    /// nothing tracked, so its index is warm if the reader switches back. Nothing is tracked when
    /// the new side is not the checkout: a server would see text contradicting the disk it indexes.
    pub async fn track(self: &Arc<Self>, snap: &Snapshot) {
        // A snapshot can land while the run is ending; a shutting-down server takes no documents.
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        let mut by_language = PathsByLanguage::new();
        if follows_checkout(snap) {
            for f in snap.changed.iter().filter(|f| f.status != ChangeStatus::D && !f.binary) {
                if let Some(language) = language_of(&f.path) {
                    by_language.entry(language).or_default().push(f.path.clone());
                }
            }
        }
        self.ensure(&by_language);
        let servers = self.servers();
        let passes = servers.iter().map(|s| {
            let tracked = paths_of(&s.routes(), &by_language);
            s.follow(&tracked);
            async move { s.bridge.track(&tracked).await }
        });
        futures::future::join_all(passes).await;
    }

    /// Idempotent: the CLI's dispose can run beside a signal handler's.
    pub async fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        futures::future::join_all(self.servers().iter().map(|s| async move { s.bridge.close().await })).await;
    }

    /// Every server for `path`, owner first; a language nothing owns is still served by the servers
    /// joining it. A file outside the snapshot goes only to the servers that named it: another
    /// server for its language may resolve it in a different environment, or not index it at all.
    /// This decides routing, not access: each bridge refuses what its own results never named.
    /// The route has asked `lsp_blocker` already, so none here is a race.
    fn servers_for(&self, path: &str) -> Result<Vec<Arc<PoolServer>>> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(Error::LspUnavailable("the language servers are shutting down".into()));
        }
        let all = self.servers();
        let found: Vec<Arc<PoolServer>> = match language_of(path) {
            Some(language) => {
                let owners = all.iter().filter(|s| s.routes().languages.contains(&language));
                let joiners = all.iter().filter(|s| s.routes().joins.contains(&language));
                owners.chain(joiners).filter(|s| s.bridge.origin(path).is_some()).cloned().collect()
            }
            None => Vec::new(),
        };
        if found.is_empty() {
            return Err(Error::LspUnavailable(format!("no language server for {path}")));
        }
        Ok(found)
    }

    fn owner_for(&self, path: &str) -> Result<Arc<PoolServer>> {
        Ok(self.servers_for(path)?.remove(0))
    }

    /// Every server's locations for `pos`, owner first, each place once.
    async fn locations(&self, pos: &LspPosition, which: Locate) -> Result<LspLocationsResponse> {
        let servers = self.servers_for(&pos.path)?;
        let asked: Vec<BoxFuture<'_, Result<LspLocationsResponse>>> = servers
            .iter()
            .map(|s| match which {
                Locate::Definition => s.bridge.definition(pos).boxed(),
                Locate::TypeDefinition => s.bridge.type_definition(pos).boxed(),
                Locate::References => s.bridge.references(pos).boxed(),
            })
            .collect();
        union(asked, merge_locations, |r: &LspLocationsResponse| r.locations.is_empty(), |r| &mut r.inconclusive).await
    }

    /// Resolves and starts servers for languages not seen before. Cheap and idempotent per language.
    fn ensure(self: &Arc<Self>, by_language: &PathsByLanguage) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        let fresh: Vec<LanguageId> = {
            let mut resolved = self.resolved.lock().unwrap();
            by_language.keys().copied().filter(|l| resolved.insert(*l)).collect()
        };
        if fresh.is_empty() {
            return;
        }
        let resolution = resolve_servers(fresh, &self.opts.overrides, &self.opts.lookup);
        let changed = !resolution.servers.is_empty() || !resolution.missing.is_empty();
        self.missing.lock().unwrap().extend(resolution.missing);
        for server in resolution.servers {
            let existing = self.entries.lock().unwrap().get(&server.command).cloned();
            // A process already up for one of its languages (clangd for c) takes the next one (cpp).
            let entry = existing.unwrap_or_else(|| {
                let routes =
                    super::pool_server::Routes { languages: server.languages.clone(), joins: server.joins.clone() };
                self.spawn(&server.command, &paths_of(&routes, by_language))
            });
            let mut routes = entry.routes.lock().unwrap();
            for l in server.languages {
                if !routes.languages.contains(&l) {
                    routes.languages.push(l);
                }
            }
            for l in server.joins {
                if !routes.joins.contains(&l) {
                    routes.joins.push(l);
                }
            }
        }
        if changed {
            self.publish();
        }
    }

    fn spawn(self: &Arc<Self>, command: &str, paths: &[String]) -> Arc<PoolServer> {
        let weak = Arc::downgrade(self);
        let opts = ServerOptions {
            root: self.opts.root.clone(),
            read: self.opts.read.clone(),
            has: self.opts.has.clone(),
            lookup: self.opts.lookup.clone(),
            max_open: self.opts.max_open,
            on_status: Arc::new(move || {
                if let Some(pool) = weak.upgrade() {
                    pool.publish();
                }
            }),
        };
        let server = Arc::new(PoolServer::new(command, paths, opts));
        self.entries.lock().unwrap().insert(command.to_owned(), server.clone());
        server
    }

    fn publish(self: &Arc<Self>) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut publish = self.publish.lock().unwrap();
            if publish.pending {
                publish.due = true;
                return;
            }
            publish.pending = true;
        }
        (self.opts.on_status)(self.status());
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(PUBLISH_WINDOW).await;
            let Some(pool) = weak.upgrade() else { return };
            let due = {
                let mut publish = pool.publish.lock().unwrap();
                publish.pending = false;
                std::mem::take(&mut publish.due)
            };
            if due {
                pool.publish();
            }
        });
    }
}
