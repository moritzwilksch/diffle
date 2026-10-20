//! This mode's threads and viewed marks in `<gitDir>/diffle/comments.json`.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::anchor::{anchor_path, compare_threads};
use crate::error::{Error, Result};
use crate::iterations::now_ms;
use crate::persist::{with_file_lock, write_file_atomic};
use crate::protocol::{CommentAnchor, CommentMessage, CommentThread, ThreadQuery, ThreadState, ViewedEntry};

/// Viewed marks kept per path: the current one plus the newest previous, so `restale` is derivable.
const VIEWED_HISTORY: usize = 2;

#[derive(Default, Serialize, Deserialize)]
pub(super) struct SetData {
    #[serde(default)]
    pub(super) threads: Vec<CommentThread>,
    #[serde(default)]
    pub(super) viewed: Vec<ViewedEntry>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct StoreFile {
    version: u8,
    pub(super) sets: BTreeMap<String, SetData>,
}

/// Owns one key's set in `comments.json`. Nothing is cached: every read parses the file, and every
/// mutation is a read-modify-write of fresh disk state under the file lock, touching only its own
/// key. So any number of stores on one file (two servers on one repository, an old mode's store
/// finishing a write while its replacement starts) see and keep each other's writes.
pub struct CommentStore {
    pub(super) file: PathBuf,
    pub(super) key: String,
}

impl CommentStore {
    pub async fn open(git_dir: &Path, key: &str) -> Result<Self> {
        Ok(Self { file: git_dir.join("diffle").join("comments.json"), key: key.to_owned() })
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    /// Threads matching `q` (every thread by default), ordered by path, line, then creation.
    pub async fn threads(&self, q: &ThreadQuery) -> Result<Vec<CommentThread>> {
        let state = q.state.unwrap_or(ThreadState::All);
        let mut threads: Vec<CommentThread> = self
            .read()
            .await?
            .threads
            .into_iter()
            .filter(|t| match state {
                ThreadState::Open => !t.resolved,
                ThreadState::Resolved => t.resolved,
                ThreadState::All => true,
            })
            .filter(|t| q.path.as_deref().is_none_or(|p| anchor_path(&t.anchor) == p))
            .collect();
        threads.sort_by(compare_threads);
        Ok(threads)
    }

    pub async fn get(&self, id: &str) -> Result<Option<CommentThread>> {
        Ok(self.read().await?.threads.into_iter().find(|t| t.id == id))
    }

    pub async fn add_thread(&self, anchor: CommentAnchor, body: String) -> Result<CommentThread> {
        self.mutate(|set| {
            let t = new_thread(anchor, body);
            set.threads.push(t.clone());
            Ok((t, true))
        })
        .await
    }

    pub async fn reply(&self, thread_id: &str, body: String) -> Result<CommentThread> {
        self.mutate(|set| {
            let t = find_thread(set, thread_id)?;
            t.messages.push(new_message(body));
            Ok((t.clone(), true))
        })
        .await
    }

    pub async fn edit_message(&self, thread_id: &str, message_id: &str, body: String) -> Result<CommentThread> {
        self.mutate(|set| {
            let t = find_thread(set, thread_id)?;
            let m =
                t.messages.iter_mut().find(|m| m.id == message_id).ok_or_else(|| Error::NotFound(message_id.into()))?;
            m.body = body;
            m.updated_at = now_ms();
            Ok((t.clone(), true))
        })
        .await
    }

    /// Removes the message, and the thread with its last message (returning none then).
    pub async fn remove_message(&self, thread_id: &str, message_id: &str) -> Result<Option<CommentThread>> {
        self.mutate(|set| {
            let t = find_thread(set, thread_id)?;
            let before = t.messages.len();
            t.messages.retain(|m| m.id != message_id);
            if t.messages.len() == before {
                return Err(Error::NotFound(message_id.into()));
            }
            if !t.messages.is_empty() {
                return Ok((Some(t.clone()), true));
            }
            set.threads.retain(|t| t.id != thread_id);
            Ok((None, true))
        })
        .await
    }

    pub async fn set_resolved(&self, thread_id: &str, resolved: bool) -> Result<CommentThread> {
        self.mutate(|set| {
            let t = find_thread(set, thread_id)?;
            t.resolved = resolved;
            t.resolved_at = resolved.then(now_ms);
            Ok((t.clone(), true))
        })
        .await
    }

    pub async fn remove_thread(&self, id: &str) -> Result<()> {
        self.mutate(|set| {
            let before = set.threads.len();
            set.threads.retain(|t| t.id != id);
            if set.threads.len() == before {
                return Err(Error::NotFound(id.into()));
            }
            Ok(((), true))
        })
        .await
    }

    pub async fn clear(&self) -> Result<()> {
        self.mutate(|set| {
            set.threads.clear();
            Ok(((), true))
        })
        .await
    }

    /// Drops every stale thread and returns how many went.
    pub async fn remove_stale(&self) -> Result<usize> {
        self.mutate(|set| {
            let before = set.threads.len();
            set.threads.retain(|t| !t.stale);
            let gone = before - set.threads.len();
            Ok((gone, gone > 0))
        })
        .await
    }

    pub async fn viewed(&self) -> Result<Vec<ViewedEntry>> {
        Ok(self.read().await?.viewed)
    }

    /// Marks or unmarks a path as viewed at a given new-side blob. The newest previous entry for the
    /// path is kept so a later blob can be recognised as re-touched.
    pub async fn set_viewed(&self, path: &str, blob: &str, viewed: bool) -> Result<Vec<ViewedEntry>> {
        self.mutate(|set| {
            let (mine, others): (Vec<ViewedEntry>, Vec<ViewedEntry>) =
                set.viewed.drain(..).partition(|v| v.path == path);
            let history: Vec<ViewedEntry> = mine.into_iter().filter(|v| v.blob != blob).collect();
            let keep = history.len().saturating_sub(VIEWED_HISTORY - 1);
            set.viewed = others;
            set.viewed.extend(history.into_iter().skip(keep));
            set.viewed.push(ViewedEntry { path: path.into(), blob: blob.into(), viewed });
            Ok((set.viewed.clone(), true))
        })
        .await
    }

    /// Replaces the marks for many paths at once; their history is dropped.
    pub async fn set_viewed_many(&self, entries: Vec<ViewedEntry>) -> Result<Vec<ViewedEntry>> {
        self.mutate(|set| {
            set.viewed.retain(|v| !entries.iter().any(|e| e.path == v.path));
            set.viewed.extend(entries);
            Ok((set.viewed.clone(), true))
        })
        .await
    }

    /// This key's set as on disk right now; empty when the file is absent. Malformed JSON fails.
    async fn read(&self) -> Result<SetData> {
        Ok(read_store_file(&self.file).await?.sets.remove(&self.key).unwrap_or_default())
    }

    /// Locked read-modify-write: `f` edits this key's set as read from disk under the lock, other
    /// keys pass through untouched, and the file is rewritten when `f` reports a change. A failing
    /// `f` writes nothing; a failed write fails its caller only.
    async fn mutate<R>(&self, f: impl FnOnce(&mut SetData) -> Result<(R, bool)>) -> Result<R> {
        with_file_lock(&self.file, || async {
            let mut all = read_store_file(&self.file).await?;
            let mut set = all.sets.remove(&self.key).unwrap_or_default();
            let (r, changed) = match f(&mut set) {
                Ok(done) => done,
                Err(e) => return Ok(Err(e)),
            };
            if changed {
                all.sets.insert(self.key.clone(), set);
                write_store_file(&self.file, &all).await?;
            }
            Ok(Ok(r))
        })
        .await?
    }
}

fn find_thread<'a>(set: &'a mut SetData, id: &str) -> Result<&'a mut CommentThread> {
    set.threads.iter_mut().find(|t| t.id == id).ok_or_else(|| Error::NotFound(id.into()))
}

/// The file as stored, or an empty store when absent. Only the current format is read: any other
/// shape reads as empty. Malformed JSON fails.
pub(super) async fn read_store_file(file: &Path) -> anyhow::Result<StoreFile> {
    let text = match tokio::fs::read_to_string(file).await {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(e) => return Err(e.into()),
    };
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(3) || !value["sets"].is_object() {
        return Ok(empty());
    }
    Ok(serde_json::from_value(value)?)
}

fn empty() -> StoreFile {
    StoreFile { version: 3, sets: BTreeMap::new() }
}

/// Atomic and owner-only: the file quotes source lines.
pub(super) async fn write_store_file(file: &Path, data: &StoreFile) -> anyhow::Result<()> {
    write_file_atomic(file, &serde_json::to_string_pretty(data)?).await
}

fn new_message(body: String) -> CommentMessage {
    let now = now_ms();
    CommentMessage { id: uuid::Uuid::new_v4().to_string(), body, created_at: now, updated_at: now }
}

pub(super) fn new_thread(anchor: CommentAnchor, body: String) -> CommentThread {
    CommentThread {
        id: uuid::Uuid::new_v4().to_string(),
        anchor,
        messages: vec![new_message(body)],
        resolved: false,
        resolved_at: None,
        stale: false,
        stale_from_line: None,
    }
}
