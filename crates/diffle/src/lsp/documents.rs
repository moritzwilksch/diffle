//! The documents one server has open, kept in step with the snapshot.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use serde_json::json;

use super::process::LspProcess;
use super::rpc::Connection;
use crate::error::{Error, Result};
use crate::protocol::language_of;

/// Navigation opens whatever file a query lands in. Without a cap every path visited in a long
/// review stays open in the server, growing its memory and per-save recheck cost.
pub const MAX_UNTRACKED_OPEN: usize = 64;

/// New-side text of a snapshot path, or none when the snapshot does not expose it.
pub type ReadFn = Arc<dyn Fn(String) -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// A document a server is asked about: a snapshot path, or a file outside the snapshot that one of
/// the server's results named, with the repository path it would have should it lie inside the
/// root. Only `Locator::origin` hands out the latter.
#[derive(Clone, Debug)]
pub enum Origin {
    Snapshot(String),
    External { abs: PathBuf, rel: Option<String> },
}

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Snapshot(path) => f.write_str(path),
            Self::External { abs, .. } => write!(f, "{}", abs.display()),
        }
    }
}

struct Doc {
    version: i64,
    text: String,
    /// Whether `text` is the snapshot's rather than the disk's.
    snapshot: bool,
}

/// Keyed by URI, so a file reached both as a snapshot path and from outside is one document.
#[derive(Default)]
struct State {
    /// Open documents, least recently synced first.
    open: IndexMap<String, Doc>,
    /// Syncs in flight, so a track pass and a query racing on one file send one didOpen.
    syncing: HashMap<String, Shared<BoxFuture<'static, Result<()>>>>,
    /// Documents `track` opened on the snapshot's behalf; closed again when they leave the snapshot.
    tracked: HashSet<String>,
}

/// The diff's own files stay open for as long as they are in it, and the files queries land in
/// until they fall off the least-recently-used end. Sends `didOpen`, `didChange`, `didClose`.
pub struct Documents {
    process: Arc<LspProcess>,
    read: ReadFn,
    /// The URI of a snapshot path.
    uri: Arc<dyn Fn(&str) -> String + Send + Sync>,
    max_open: usize,
    state: Arc<Mutex<State>>,
    /// Track passes run one at a time; the last set wins.
    tracking: tokio::sync::Mutex<()>,
}

impl Documents {
    pub fn new(
        process: Arc<LspProcess>,
        read: ReadFn,
        uri: Arc<dyn Fn(&str) -> String + Send + Sync>,
        max_open: Option<usize>,
    ) -> Self {
        let max_open = max_open.unwrap_or(MAX_UNTRACKED_OPEN);
        Self { process, read, uri, max_open, state: Arc::default(), tracking: tokio::sync::Mutex::new(()) }
    }

    /// The URI the server knows `origin` by.
    pub fn uri(&self, origin: &Origin) -> String {
        uri_of(&*self.uri, origin)
    }

    /// The snapshot text the server holds for an open snapshot path; none when it holds the disk's
    /// text for a file the snapshot hides.
    pub fn text_of(&self, path: &str) -> Option<String> {
        self.state.lock().unwrap().open.get(&(self.uri)(path)).filter(|d| d.snapshot).map(|d| d.text.clone())
    }

    /// Opens or updates the document so the server sees its text before a request: the snapshot's
    /// whenever the snapshot exposes it, else the disk's for an outside file. Concurrent syncs of one document share
    /// one read and notification. Untracked documents beyond the cap are closed, least recently
    /// used first.
    pub async fn sync(&self, origin: &Origin) -> Result<()> {
        let uri = self.uri(origin);
        let task = {
            let mut state = self.state.lock().unwrap();
            if let Some(task) = state.syncing.get(&uri) {
                task.clone()
            } else {
                let (process, read, max, shared) =
                    (self.process.clone(), self.read.clone(), self.max_open, self.state.clone());
                let (origin, key) = (origin.clone(), uri.clone());
                let task = async move {
                    let result = sync_now(&process, &read, max, &shared, &origin, &key).await;
                    shared.lock().unwrap().syncing.remove(&key);
                    result
                }
                .boxed()
                .shared();
                state.syncing.insert(uri, task.clone());
                task
            }
        };
        task.await
    }

    /// Keeps the diff's own files open with their snapshot text: servers index lazily and cap what
    /// they index, so a reference in a changed file nobody queried yet is otherwise found late, and
    /// from the disk. Passes are serialized; the last set wins. Never fails: a path the snapshot
    /// cannot read is skipped.
    pub async fn track(&self, paths: &[String]) {
        let _turn = self.tracking.lock().await;
        let Ok(rpc) = self.process.connection().await else { return };
        let next: HashSet<String> = paths.iter().map(|p| (self.uri)(p)).collect();
        let closed: Vec<String> = {
            let mut state = self.state.lock().unwrap();
            let gone: Vec<String> = state.tracked.iter().filter(|u| !next.contains(*u)).cloned().collect();
            gone.into_iter()
                .filter(|uri| {
                    state.tracked.remove(uri);
                    state.open.shift_remove(uri).is_some()
                })
                .collect()
        };
        for uri in closed {
            rpc.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
        }
        for path in paths {
            match self.sync(&Origin::Snapshot(path.clone())).await {
                Ok(()) => drop(self.state.lock().unwrap().tracked.insert((self.uri)(path))),
                Err(Error::LspUnavailable(_)) => return,
                // Not readable on the new side (deleted, binary, gone since the snapshot): nothing to open.
                Err(_) => {}
            }
        }
    }
}

fn uri_of(snapshot_uri: &(dyn Fn(&str) -> String + Send + Sync), origin: &Origin) -> String {
    match origin {
        Origin::Snapshot(path) => snapshot_uri(path),
        Origin::External { abs, .. } => {
            url::Url::from_file_path(abs).map_or_else(|()| format!("file://{}", abs.display()), |u| u.to_string())
        }
    }
}

async fn sync_now(
    process: &LspProcess,
    read: &ReadFn,
    max_open: usize,
    state: &Mutex<State>,
    origin: &Origin,
    uri: &str,
) -> Result<()> {
    let rpc = process.connection().await?;
    // A hidden file that joined the snapshot shares its URI with the snapshot path: the snapshot's
    // text wins, so the one document does not flip between the two.
    let in_snapshot = match origin {
        Origin::Snapshot(path) | Origin::External { rel: Some(path), .. } => read(path.clone()).await,
        Origin::External { rel: None, .. } => None,
    };
    let (text, snapshot) = match (in_snapshot, origin) {
        (Some(text), _) => (text, true),
        (None, Origin::Snapshot(path)) => return Err(Error::Invalid(format!("{path} is not in the snapshot"))),
        (None, Origin::External { abs, .. }) => match tokio::fs::read_to_string(abs).await {
            Ok(text) => (text, false),
            Err(_) => return Err(Error::Invalid(format!("{origin} is no longer readable"))),
        },
    };
    let path = origin.to_string();
    let mut state = state.lock().unwrap();
    match state.open.shift_remove(uri) {
        None => {
            let language = language_of(&path).map_or_else(|| "plaintext".to_owned(), |l| l.to_string());
            let open = json!({ "textDocument": { "uri": uri, "languageId": language, "version": 1, "text": text } });
            state.open.insert(uri.to_owned(), Doc { version: 1, text, snapshot });
            rpc.notify("textDocument/didOpen", open);
        }
        // Re-inserted at the end: the most recently used.
        Some(mut doc) => {
            if doc.text != text {
                doc.version += 1;
                let change = json!({ "textDocument": { "uri": uri, "version": doc.version }, "contentChanges": [{ "text": text }] });
                doc.text = text;
                rpc.notify("textDocument/didChange", change);
            }
            doc.snapshot = snapshot;
            state.open.insert(uri.to_owned(), doc);
        }
    }
    evict(&mut state, &rpc, max_open);
    Ok(())
}

/// Closes the least recently used untracked documents until at most `max_open` remain.
fn evict(state: &mut State, rpc: &Connection, max_open: usize) {
    let untracked = state.open.keys().filter(|u| !state.tracked.contains(*u)).count();
    let victims: Vec<String> = state
        .open
        .keys()
        .filter(|u| !state.tracked.contains(*u) && !state.syncing.contains_key(*u))
        .take(untracked.saturating_sub(max_open))
        .cloned()
        .collect();
    for uri in victims {
        state.open.shift_remove(&uri);
        rpc.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri } }));
    }
}
