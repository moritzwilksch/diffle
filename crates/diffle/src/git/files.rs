//! Reading either side: blobs from the object database, worktree files from disk.
use std::collections::HashMap;

use gix::objs::Kind;
use tokio::io::AsyncReadExt;

use super::{GitRepo, WORKTREE, inside};
use crate::error::GitError;

impl GitRepo {
    /// Blob contents at `rev`, or none if absent or not a blob (a directory, a gitlink).
    pub async fn show(&self, rev: &str, path: &str) -> Result<Option<Vec<u8>>, GitError> {
        self.blob_at(rev, path, usize::MAX).await
    }

    /// The first `keep` bytes of the blob at `rev:path`. A revision or path that names nothing is
    /// none, as `cat-file` reports it missing.
    async fn blob_at(&self, rev: &str, path: &str, keep: usize) -> Result<Option<Vec<u8>>, GitError> {
        let (rev, path) = (rev.to_owned(), path.to_owned());
        self.gix("reading a blob", move |repo| {
            let Ok(id) = repo.rev_parse_single(rev.as_str()) else {
                return Ok(None);
            };
            let Ok(tree) = id.object()?.peel_to_tree() else {
                return Ok(None);
            };
            let Some(entry) = tree.lookup_entry_by_path(&path)? else {
                return Ok(None);
            };
            Ok(blob_head(repo, entry.object_id(), keep)?)
        })
        .await
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
        let shas = shas.to_vec();
        self.gix("reading blobs", move |repo| {
            let mut heads = HashMap::new();
            for sha in shas {
                let Ok(id) = gix::ObjectId::from_hex(sha.as_bytes()) else { continue };
                if let Some(head) = blob_head(repo, id, bytes)? {
                    heads.insert(sha, head);
                }
            }
            Ok(heads)
        })
        .await
    }

    /// First `bytes` of a file on the new side, or none if absent. The worktree read is bounded at
    /// the file.
    pub async fn head(&self, rev: &str, path: &str, bytes: usize) -> anyhow::Result<Option<Vec<u8>>> {
        if rev != WORKTREE {
            return Ok(self.blob_at(rev, path, bytes).await?);
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

/// The first `keep` bytes of a blob, or none when `id` is missing or not a blob.
fn blob_head(repo: &gix::Repository, id: gix::ObjectId, keep: usize) -> gix::Result<Option<Vec<u8>>> {
    let Some(object) = repo.try_find_object(id)? else {
        return Ok(None);
    };
    if object.kind != Kind::Blob {
        return Ok(None);
    }
    let mut body = object.detach().data;
    body.truncate(keep);
    Ok(Some(body))
}
