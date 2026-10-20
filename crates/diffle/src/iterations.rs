//! The iterations of a reviewed range: each distinct pair of endpoints a snapshot saw.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::git::GitRepo;
use crate::persist::{with_file_lock, write_file_atomic};
use crate::protocol::Iteration;

/// Iterations kept per range; the oldest beyond this are forgotten and unpinned.
pub const MAX_ITERATIONS: usize = 50;

#[derive(Serialize, Deserialize)]
struct File {
    version: u8,
    ranges: BTreeMap<String, Vec<Iteration>>,
}

/// The iterations of one range, under its comment key in `<gitDir>/diffle/iterations.json`. Nothing
/// is cached: every mutation is a read-modify-write of fresh disk state under the file lock, so two
/// servers on one repository keep each other's records. Each iteration's commits are pinned under
/// `refs/diffle/iterations/<key hash>/<n>/{old,new}`.
pub struct IterationStore {
    repo: Arc<GitRepo>,
    pub key: String,
    file: PathBuf,
    refs: String,
}

impl IterationStore {
    pub fn new(repo: Arc<GitRepo>, key: String) -> Self {
        let file = repo.git_dir.join("diffle").join("iterations.json");
        let hash = hex::encode(Sha1::digest(key.as_bytes()));
        Self { refs: format!("refs/diffle/iterations/{}", &hash[..16]), repo, key, file }
    }

    /// Oldest first.
    pub async fn list(&self) -> anyhow::Result<Vec<Iteration>> {
        Ok(self.read().await?.ranges.remove(&self.key).unwrap_or_default())
    }

    pub async fn get(&self, n: i64) -> anyhow::Result<Option<Iteration>> {
        Ok(self.list().await?.into_iter().find(|it| it.n == n))
    }

    /// Records the endpoints as the next iteration, unless the latest already has them, and returns
    /// the list afterwards. Pins the commits first, so a recorded iteration is always reachable.
    pub async fn record(&self, old_sha: &str, new_sha: &str) -> anyhow::Result<Vec<Iteration>> {
        with_file_lock(&self.file, || async {
            let mut all = self.read().await?;
            let mut list = all.ranges.remove(&self.key).unwrap_or_default();
            if list.last().is_some_and(|last| last.old_sha == old_sha && last.new_sha == new_sha) {
                return Ok(list);
            }
            let n = list.last().map_or(0, |last| last.n) + 1;
            list.push(Iteration { n, old_sha: old_sha.to_owned(), new_sha: new_sha.to_owned(), recorded_at: now_ms() });
            let dropped: Vec<Iteration> = list.drain(..list.len().saturating_sub(MAX_ITERATIONS)).collect();
            let mut pins =
                vec![(self.pin(n, "old"), Some(old_sha.to_owned())), (self.pin(n, "new"), Some(new_sha.to_owned()))];
            pins.extend(self.unpins(&dropped));
            self.repo.pin(&pins).await?;
            all.ranges.insert(self.key.clone(), list.clone());
            self.write(&all).await?;
            Ok(list)
        })
        .await
    }

    /// Forgets the iteration numbered `n`, if recorded, and unpins its commits. The rest keep their numbers.
    pub async fn remove(&self, n: i64) -> anyhow::Result<Vec<Iteration>> {
        with_file_lock(&self.file, || async {
            let mut all = self.read().await?;
            let list = all.ranges.remove(&self.key).unwrap_or_default();
            let (gone, kept): (Vec<_>, Vec<_>) = list.into_iter().partition(|it| it.n == n);
            if gone.is_empty() {
                return Ok(kept);
            }
            self.repo.pin(&self.unpins(&gone)).await?;
            if !kept.is_empty() {
                all.ranges.insert(self.key.clone(), kept.clone());
            }
            self.write(&all).await?;
            Ok(kept)
        })
        .await
    }

    /// Forgets every iteration of this range and unpins their commits.
    pub async fn clear(&self) -> anyhow::Result<()> {
        with_file_lock(&self.file, || async {
            let mut all = self.read().await?;
            let list = all.ranges.remove(&self.key).unwrap_or_default();
            self.repo.pin(&self.unpins(&list)).await?;
            self.write(&all).await
        })
        .await
    }

    fn pin(&self, n: i64, side: &str) -> String {
        format!("{}/{n}/{side}", self.refs)
    }

    fn unpins(&self, iterations: &[Iteration]) -> Vec<(String, Option<String>)> {
        iterations.iter().flat_map(|it| [(self.pin(it.n, "old"), None), (self.pin(it.n, "new"), None)]).collect()
    }

    async fn read(&self) -> anyhow::Result<File> {
        match tokio::fs::read_to_string(&self.file).await {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(File { version: 1, ranges: BTreeMap::new() }),
            Err(e) => Err(e.into()),
        }
    }

    async fn write(&self, all: &File) -> anyhow::Result<()> {
        write_file_atomic(&self.file, &(serde_json::to_string_pretty(all)? + "\n")).await
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}
