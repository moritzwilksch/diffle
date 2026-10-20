//! The documents one server has open, kept in step with the snapshot.
use std::collections::{HashMap, HashSet};
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

struct Doc {
    version: i64,
    text: String,
}

#[derive(Default)]
struct State {
    /// Open documents, least recently synced first.
    open: IndexMap<String, Doc>,
    /// Syncs in flight by path, so a track pass and a query racing on one file send one didOpen.
    syncing: HashMap<String, Shared<BoxFuture<'static, Result<()>>>>,
    /// Paths `track` opened on the snapshot's behalf; closed again when they leave the snapshot.
    tracked: HashSet<String>,
}

/// The diff's own files stay open for as long as they are in it, and the files queries land in
/// until they fall off the least-recently-used end. Sends `didOpen`, `didChange`, `didClose`.
pub struct Documents {
    process: Arc<LspProcess>,
    read: ReadFn,
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

    /// The text the server holds for an open path.
    pub fn text_of(&self, path: &str) -> Option<String> {
        self.state.lock().unwrap().open.get(path).map(|d| d.text.clone())
    }

    /// Opens or updates the document so the server sees the snapshot's text before a request.
    /// Concurrent syncs of one path share one read and notification. Untracked documents beyond
    /// the cap are closed, least recently used first.
    pub async fn sync(&self, path: &str) -> Result<()> {
        let task = {
            let mut state = self.state.lock().unwrap();
            if let Some(task) = state.syncing.get(path) {
                task.clone()
            } else {
                let (process, read, uri, max, shared) =
                    (self.process.clone(), self.read.clone(), self.uri.clone(), self.max_open, self.state.clone());
                let owned = path.to_owned();
                let task = async move {
                    let result = sync_now(&process, &read, &*uri, max, &shared, &owned).await;
                    shared.lock().unwrap().syncing.remove(&owned);
                    result
                }
                .boxed()
                .shared();
                state.syncing.insert(path.to_owned(), task.clone());
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
        let next: HashSet<&String> = paths.iter().collect();
        let closed: Vec<String> = {
            let mut state = self.state.lock().unwrap();
            let gone: Vec<String> = state.tracked.iter().filter(|p| !next.contains(p)).cloned().collect();
            gone.into_iter()
                .filter(|path| {
                    state.tracked.remove(path);
                    state.open.shift_remove(path).is_some()
                })
                .collect()
        };
        for path in closed {
            rpc.notify("textDocument/didClose", json!({ "textDocument": { "uri": (self.uri)(&path) } }));
        }
        for path in paths {
            match self.sync(path).await {
                Ok(()) => drop(self.state.lock().unwrap().tracked.insert(path.clone())),
                Err(Error::LspUnavailable(_)) => return,
                // Not readable on the new side (deleted, binary, gone since the snapshot): nothing to open.
                Err(_) => {}
            }
        }
    }
}

async fn sync_now(
    process: &LspProcess,
    read: &ReadFn,
    uri: &(dyn Fn(&str) -> String + Send + Sync),
    max_open: usize,
    state: &Mutex<State>,
    path: &str,
) -> Result<()> {
    let rpc = process.connection().await?;
    let Some(text) = read(path.to_owned()).await else {
        return Err(Error::Invalid(format!("{path} is not in the snapshot")));
    };
    let uri_of = uri(path);
    let mut state = state.lock().unwrap();
    match state.open.shift_remove(path) {
        None => {
            let language = language_of(path).map_or_else(|| "plaintext".to_owned(), |l| l.to_string());
            let open = json!({ "textDocument": { "uri": uri_of, "languageId": language, "version": 1, "text": text } });
            state.open.insert(path.to_owned(), Doc { version: 1, text });
            rpc.notify("textDocument/didOpen", open);
        }
        // Re-inserted at the end: the most recently used.
        Some(mut doc) => {
            if doc.text != text {
                doc.version += 1;
                let change = json!({ "textDocument": { "uri": uri_of, "version": doc.version }, "contentChanges": [{ "text": text }] });
                doc.text = text;
                rpc.notify("textDocument/didChange", change);
            }
            state.open.insert(path.to_owned(), doc);
        }
    }
    evict(&mut state, &rpc, uri, max_open);
    Ok(())
}

/// Closes the least recently used untracked documents until at most `max_open` remain.
fn evict(state: &mut State, rpc: &Connection, uri: &(dyn Fn(&str) -> String + Send + Sync), max_open: usize) {
    let untracked = state.open.keys().filter(|p| !state.tracked.contains(*p)).count();
    let victims: Vec<String> = state
        .open
        .keys()
        .filter(|p| !state.tracked.contains(*p) && !state.syncing.contains_key(*p))
        .take(untracked.saturating_sub(max_open))
        .cloned()
        .collect();
    for path in victims {
        state.open.shift_remove(&path);
        rpc.notify("textDocument/didClose", json!({ "textDocument": { "uri": uri(&path) } }));
    }
}
