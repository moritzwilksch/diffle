//! The copies of the sides a generator reads: the matched changed files, or the whole snapshot,
//! each side as the review shows it.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::{StreamExt, TryStreamExt, stream};

use super::catalog::Scope;
use super::input::safe_relative;
use crate::error::{Error, Result};
use crate::protocol::{ChangeStatus, ChangedFile, Side, Snapshot};
use crate::session::Session;

/// Concurrent side reads while copying.
const COPY_CONCURRENCY: usize = 8;

/// Writes the files a generator gets into `old` and `new`: the matched changed files, or the
/// whole snapshot, each side as the review shows it. Ignored files are absent, as everywhere.
pub(super) async fn materialize(
    session: &Arc<Session>,
    snap: &Arc<Snapshot>,
    scope: Scope,
    matched: &[String],
    old: &Path,
    new: &Path,
) -> Result<()> {
    let by_path: HashMap<&str, &ChangedFile> = snap.changed.iter().map(|f| (f.path.as_str(), f)).collect();
    let new_paths: Vec<String> = match scope {
        Scope::Changed => matched
            .iter()
            .filter(|p| by_path.get(p.as_str()).is_none_or(|f| f.status != ChangeStatus::D))
            .cloned()
            .collect(),
        Scope::Tree => snap.tree.clone(),
    };
    // Old side: every path read by its new name, written under its old one; deleted files too.
    let mut old_paths: Vec<(String, String)> = match scope {
        Scope::Changed => matched.to_vec(),
        Scope::Tree => snap.tree.clone(),
    }
    .into_iter()
    .filter(|p| by_path.get(p.as_str()).is_none_or(|f| f.status != ChangeStatus::A))
    .map(|p| {
        let target = by_path.get(p.as_str()).and_then(|f| f.old_path.clone()).unwrap_or_else(|| p.clone());
        (p, target)
    })
    .collect();
    if scope == Scope::Tree {
        old_paths.extend(
            snap.changed.iter().filter(|f| f.status == ChangeStatus::D).map(|f| (f.path.clone(), f.path.clone())),
        );
    }
    let copy = |side: Side, read_as: String, write_as: String, dir: PathBuf| async move {
        if !safe_relative(&write_as) {
            return Ok::<(), Error>(());
        }
        let Some(bytes) = session.read_side(snap, &read_as, side).await? else { return Ok(()) };
        let file = dir.join(&write_as);
        if let Some(parent) = file.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&file, bytes).await?;
        Ok(())
    };
    let news = new_paths.into_iter().map(|p| copy(Side::New, p.clone(), p, new.to_path_buf()));
    stream::iter(news).buffer_unordered(COPY_CONCURRENCY).try_collect::<Vec<()>>().await?;
    let olds = old_paths.into_iter().map(|(read_as, write_as)| copy(Side::Old, read_as, write_as, old.to_path_buf()));
    stream::iter(olds).buffer_unordered(COPY_CONCURRENCY).try_collect::<Vec<()>>().await?;
    Ok(())
}
