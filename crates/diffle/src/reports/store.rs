//! What a report keeps on disk: pushed reports in `<git-dir>/diffle/reports.json`, under the
//! review's comment key, and every report's files as content-addressed blobs beside it.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::error::{Error, Result};
use crate::persist::{with_file_lock, write_file_atomic};
use crate::protocol::{ReportBlock, ReportFile, ReportSource, ReportStatus, ReportTarget};
use crate::server::image::image_type;

/// The largest file a report may name.
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;

/// A report as kept: what the client gets, minus `stale`, plus the files by their authored
/// path, so a report put again may name the same files without uploading them again.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub id: String,
    pub source: ReportSource,
    pub title: String,
    pub summary: String,
    pub target: ReportTarget,
    pub status: ReportStatus,
    pub error: Option<String>,
    pub updated_at: i64,
    pub blocks: Vec<ReportBlock>,
    #[serde(default)]
    pub files: HashMap<String, ReportFile>,
}

impl Stored {
    /// Every blob key the report's pages name.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.blocks.iter().flat_map(|b| match b {
            ReportBlock::Markdown { .. } => Vec::new(),
            ReportBlock::Pages { pages, .. } => {
                pages.iter().flat_map(|p| [p.old.as_ref(), p.new.as_ref()]).flatten().map(|f| f.key.as_str()).collect()
            }
        })
    }
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u8,
    /// Pushed reports by comment key.
    sets: BTreeMap<String, Vec<Stored>>,
}

/// Owns `reports.json` and the blob folder. Nothing is cached: every mutation is a read-modify-write
/// under the file lock, touching only its own key, so two servers on one repository keep each
/// other's reports.
pub struct ReportStore {
    file: PathBuf,
    blobs: PathBuf,
}

impl ReportStore {
    pub fn new(git_dir: &Path) -> Self {
        let dir = git_dir.join("diffle");
        Self { file: dir.join("reports.json"), blobs: dir.join("reports") }
    }

    /// The pushed reports under `key`, as on disk now.
    pub async fn load(&self, key: &str) -> Result<Vec<Stored>> {
        Ok(read_store_file(&self.file).await?.sets.remove(key).unwrap_or_default())
    }

    /// Replaces the pushed reports under `key`.
    pub async fn save(&self, key: &str, reports: &[Stored]) -> Result<()> {
        with_file_lock(&self.file, || async {
            let mut all = read_store_file(&self.file).await?;
            if reports.is_empty() {
                all.sets.remove(key);
            } else {
                all.sets.insert(key.to_owned(), reports.to_vec());
            }
            write_file_atomic(&self.file, &serde_json::to_string_pretty(&all)?).await
        })
        .await?;
        Ok(())
    }

    /// Keeps `bytes` under their digest, when they are a raster image. The key is the digest, so
    /// the same bytes land once however often they are put.
    pub async fn put_blob(&self, bytes: &[u8]) -> Result<ReportFile> {
        let Some(type_) = image_type(bytes) else {
            return Err(Error::Invalid("not a raster image (png, jpeg, gif, webp, avif, bmp)".into()));
        };
        if bytes.len() > MAX_FILE_BYTES {
            return Err(Error::Invalid(format!("at most {} bytes per file", MAX_FILE_BYTES)));
        }
        let key = hex::encode(Sha1::digest(bytes));
        let file = self.blobs.join(&key);
        if tokio::fs::metadata(&file).await.is_err() {
            tokio::fs::create_dir_all(&self.blobs).await?;
            let tmp = self.blobs.join(format!("{key}.{}.tmp", uuid::Uuid::new_v4().simple()));
            tokio::fs::write(&tmp, bytes).await?;
            if let Err(e) = tokio::fs::rename(&tmp, &file).await {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e.into());
            }
        }
        Ok(ReportFile { key, type_: type_.to_owned() })
    }

    /// The bytes under `key` and their type, or none.
    pub async fn read_blob(&self, key: &str) -> Result<Option<(Vec<u8>, &'static str)>> {
        if key.len() != 40 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(None);
        }
        match tokio::fs::read(self.blobs.join(key)).await {
            Ok(bytes) => Ok(image_type(&bytes).map(|t| (bytes, t))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Removes every blob no pushed report on disk and nothing in `keep` names. A blob younger
    /// than `grace` stays: a run still going may have written it and not named it yet.
    pub async fn sweep(&self, keep: &HashSet<String>, grace: Duration) -> Result<()> {
        let mut named: HashSet<String> = keep.clone();
        for report in read_store_file(&self.file).await?.sets.values().flatten() {
            named.extend(report.keys().map(str::to_owned));
        }
        let mut entries = match tokio::fs::read_dir(&self.blobs).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let young = entry
                .metadata()
                .await
                .and_then(|m| m.modified())
                .map(|at| at.elapsed().unwrap_or_default() < grace)
                .unwrap_or(true);
            // A `<key>.<pid>.tmp` is a put in flight; only a finished blob is ever swept.
            let blob = name.len() == 40 && name.bytes().all(|b| b.is_ascii_hexdigit());
            if blob && !named.contains(&name) && !young {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
        Ok(())
    }
}

/// The file as stored, or an empty store when absent or of another format. Malformed JSON fails.
async fn read_store_file(file: &Path) -> anyhow::Result<StoreFile> {
    let text = match tokio::fs::read_to_string(file).await {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(e) => return Err(e.into()),
    };
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) || !value["sets"].is_object() {
        return Ok(empty());
    }
    Ok(serde_json::from_value(value)?)
}

fn empty() -> StoreFile {
    StoreFile { version: 1, sets: BTreeMap::new() }
}
