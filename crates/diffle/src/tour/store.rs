//! The tours in `<git-dir>/diffle/tours.json`: one per comment key, as the agent last pushed it.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::persist::{with_file_lock, write_file_atomic};
use crate::protocol::Tour;

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u8,
    tours: BTreeMap<String, Tour>,
}

/// Owns one key's tour in `tours.json`. Like `CommentStore`, it caches nothing: every write is a
/// read-modify-write under the file lock that leaves other keys alone.
pub struct TourStore {
    file: PathBuf,
    key: String,
}

impl TourStore {
    pub fn open(git_dir: &Path, key: &str) -> Self {
        Self { file: git_dir.join("diffle").join("tours.json"), key: key.to_owned() }
    }

    pub async fn get(&self) -> Result<Option<Tour>> {
        Ok(read(&self.file).await?.tours.remove(&self.key))
    }

    /// Replaces this key's tour.
    pub async fn put(&self, tour: Tour) -> Result<()> {
        self.mutate(|tours| {
            tours.insert(self.key.clone(), tour);
            true
        })
        .await
    }

    /// Removes this key's tour; whether there was one.
    pub async fn clear(&self) -> Result<bool> {
        let mut removed = false;
        self.mutate(|tours| {
            removed = tours.remove(&self.key).is_some();
            removed
        })
        .await?;
        Ok(removed)
    }

    /// Rewrites the file when `f` reports a change to the tours read under the lock.
    async fn mutate(&self, f: impl FnOnce(&mut BTreeMap<String, Tour>) -> bool) -> Result<()> {
        with_file_lock(&self.file, || async {
            let mut all = read(&self.file).await?;
            if f(&mut all.tours) {
                write_file_atomic(&self.file, &serde_json::to_string_pretty(&all)?).await?;
            }
            Ok(())
        })
        .await?;
        Ok(())
    }
}

/// The file as stored, or no tours when it is absent or in another format. Malformed JSON fails.
async fn read(file: &Path) -> anyhow::Result<StoreFile> {
    let empty = StoreFile { version: 1, tours: BTreeMap::new() };
    let text = match tokio::fs::read_to_string(file).await {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty),
        Err(e) => return Err(e.into()),
    };
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Ok(empty);
    }
    Ok(serde_json::from_value(value)?)
}
