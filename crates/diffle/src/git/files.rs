//! Reading either side: blobs through the shared batch, worktree files from disk.
use std::collections::HashMap;

use tokio::io::AsyncReadExt;

use super::{GitRepo, WORKTREE, inside};
use crate::error::GitError;

impl GitRepo {
    /// Blob contents at `rev`, or none if absent or not a blob (a directory, a gitlink).
    pub async fn show(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>, GitError> {
        let object = self.cat_file.request(&format!("{rev}:{path}"), usize::MAX).await?;
        Ok(object.filter(|o| o.kind == "blob").map(|o| o.body))
    }

    /// Worktree file at a repo-relative path, or none if absent or not a file. A symlink yields its
    /// target string, which is what git stores for it, so a link pointing outside the repository
    /// never exposes the target's contents.
    pub async fn read_worktree(&self, path: &str) -> std::io::Result<Option<Vec<u8>>> {
        let Some(abs) = inside(&self.root, path) else {
            return Ok(None);
        };
        let meta = match tokio::fs::symlink_metadata(&abs).await {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if meta.is_symlink() {
            return Ok(Some(tokio::fs::read_link(&abs).await?.to_string_lossy().into_owned().into_bytes()));
        }
        if !meta.is_file() {
            return Ok(None);
        }
        tokio::fs::read(&abs).await.map(Some)
    }

    /// First `bytes` of each blob, keyed by sha; one batch answers the whole list. A sha that is
    /// not a blob (missing, a gitlink) is absent from the result.
    pub async fn blob_heads(&self, shas: &[String], bytes: usize) -> Result<HashMap<String, Vec<u8>>, GitError> {
        let objects = futures::future::try_join_all(shas.iter().map(|sha| self.cat_file.request(sha, bytes))).await?;
        Ok(shas
            .iter()
            .zip(objects)
            .filter_map(|(sha, o)| o.filter(|o| o.kind == "blob").map(|o| (sha.clone(), o.body)))
            .collect())
    }

    /// First `bytes` of a file on the new side, or none if absent. The worktree read is bounded at
    /// the file; a blob streams through the batch reader, which keeps only the prefix.
    pub async fn head(&self, rev: &str, path: &str, bytes: usize) -> anyhow::Result<Option<Vec<u8>>> {
        if rev != WORKTREE {
            let object = self.cat_file.request(&format!("{rev}:{path}"), bytes).await?;
            return Ok(object.filter(|o| o.kind == "blob").map(|o| o.body));
        }
        let Some(abs) = inside(&self.root, path) else {
            return Ok(None);
        };
        match tokio::fs::symlink_metadata(&abs).await {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        let mut buf = Vec::with_capacity(bytes.min(64 * 1024));
        tokio::fs::File::open(&abs).await?.take(bytes as u64).read_to_end(&mut buf).await?;
        Ok(Some(buf))
    }
}
