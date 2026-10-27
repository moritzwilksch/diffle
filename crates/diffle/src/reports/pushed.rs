//! Reports pushed over the API: files uploaded ahead, the put that resolves them, and removal.
use std::collections::HashSet;

use super::store::Stored;
use super::{Reports, block_keys, input};
use crate::error::{Error, Result};
use crate::iterations::now_ms;
use crate::protocol::{Report, ReportFile, ReportInput, ReportSource, ReportStatus, ServerMessage, Side};

impl Reports {
    /// Keeps `bytes` for the next put of report `id`, under the authored `path`.
    pub async fn upload(&self, id: &str, path: &str, bytes: &[u8]) -> Result<ReportFile> {
        input::check_id(id)?;
        if !input::safe_relative(path) {
            return Err(Error::Invalid(format!("path: a relative path, got \"{path}\"")));
        }
        let file = self.store.put_blob(bytes).await?;
        self.state.lock().unwrap().uploads.entry(id.to_owned()).or_default().insert(path.to_owned(), file.clone());
        Ok(file)
    }

    /// Creates or replaces the pushed report `id` for the current snapshot. True when created.
    pub async fn put(&self, id: &str, report: ReportInput) -> Result<(Report, bool)> {
        input::check_id(id)?;
        let (snap, current) = self.current().await?;
        let (files, created) = {
            let state = self.state.lock().unwrap();
            if state.generated.contains_key(id) {
                return Err(Error::Conflict(format!("\"{id}\" is a generator's report; pick another id")));
            }
            let mut files = state.pushed.get(id).map(|r| r.files.clone()).unwrap_or_default();
            // Uploads outlive a refused put: the caller fixes the report, not the files.
            files.extend(state.uploads.get(id).cloned().unwrap_or_default());
            (files, !state.pushed.contains_key(id))
        };
        let session = self.session.clone();
        let shown = |path: &str, side: Side| -> bool { session.has_side(&snap, path, side) };
        let valid = input::validate(report, &files, shown)?;
        let named: HashSet<&str> = valid.blocks.iter().flat_map(block_keys).collect();
        let files = files.into_iter().filter(|(_, f)| named.contains(f.key.as_str())).collect();
        let stored = Stored {
            id: id.to_owned(),
            source: ReportSource::Pushed,
            title: valid.title,
            summary: valid.summary,
            target: current.clone(),
            status: ReportStatus::Ready,
            error: None,
            updated_at: now_ms(),
            blocks: valid.blocks,
            files,
        };
        let served = Self::served(&stored, &current);
        let pushed: Vec<Stored> = {
            let mut state = self.state.lock().unwrap();
            state.uploads.remove(id);
            state.logs.insert(id.to_owned(), valid.notes);
            state.pushed.insert(id.to_owned(), stored);
            state.pushed.values().cloned().collect()
        };
        self.store.save(&snap.comment_key, &pushed).await?;
        self.sweep().await;
        self.hub.broadcast(ServerMessage::Reports);
        Ok((served, created))
    }

    /// Removes the pushed report `id`; a generator's cannot go.
    pub async fn delete(&self, id: &str) -> Result<()> {
        let (snap, _) = self.current().await?;
        let pushed: Vec<Stored> = {
            let mut state = self.state.lock().unwrap();
            if state.generated.contains_key(id) {
                return Err(Error::Conflict(format!("\"{id}\" is a generator's report; turn the plugin off instead")));
            }
            state.pushed.remove(id).ok_or_else(|| Error::NotFound(id.into()))?;
            state.logs.remove(id);
            state.pushed.values().cloned().collect()
        };
        self.store.save(&snap.comment_key, &pushed).await?;
        self.sweep().await;
        self.hub.broadcast(ServerMessage::Reports);
        Ok(())
    }
}
