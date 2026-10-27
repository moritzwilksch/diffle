//! Reports the generators make: started on every snapshot, superseded by the next, cached by input.
use std::collections::HashMap;
use std::sync::Arc;

use super::catalog::{self, Plugin};
use super::runner::{self, Failure, Produced};
use super::store::Stored;
use super::{Reports, target_of};
use crate::iterations::now_ms;
use crate::protocol::{ReportSource, ReportStatus, ReportTarget, ServerMessage, Snapshot};

impl Reports {
    /// Follows a snapshot: loads its pushed reports and starts its generators.
    pub(super) async fn sync(self: Arc<Self>, snap: Arc<Snapshot>) {
        if let Err(e) = self.load_pushed(&snap).await {
            crate::status!("[diffle] loading reports: {e:#}");
        }
        let target = target_of(&snap);
        let mut changed = false;
        {
            let mut state = self.state.lock().unwrap();
            if snap.version < state.version {
                return;
            }
            state.version = snap.version;
            for plugin in &self.plugins {
                let matched = catalog::matched(plugin, &snap.changed);
                if matched.is_empty() {
                    changed |= state.generated.remove(&plugin.name).is_some();
                    if let Some(run) = self.runs.lock().unwrap().remove(&plugin.name) {
                        run.abort();
                    }
                    continue;
                }
                changed = true;
                let previous = state.generated.get(&plugin.name);
                let stored = Stored {
                    id: plugin.name.clone(),
                    source: ReportSource::Generator,
                    title: previous.map_or_else(|| plugin.name.clone(), |p| p.title.clone()),
                    summary: previous.map(|p| p.summary.clone()).unwrap_or_default(),
                    target: previous.map_or_else(|| target.clone(), |p| p.target.clone()),
                    status: ReportStatus::Running,
                    error: None,
                    updated_at: now_ms(),
                    blocks: previous.map(|p| p.blocks.clone()).unwrap_or_default(),
                    files: HashMap::new(),
                };
                state.generated.insert(plugin.name.clone(), stored);
                self.start(snap.clone(), target.clone(), plugin.clone(), matched);
            }
        }
        if changed {
            self.hub.broadcast(ServerMessage::Reports);
        }
    }

    /// Runs `plugin` for `snap` on its own task, in place of any run still going for it.
    fn start(self: &Arc<Self>, snap: Arc<Snapshot>, target: ReportTarget, plugin: Plugin, matched: Vec<String>) {
        let this = self.clone();
        let name = plugin.name.clone();
        let task = tokio::spawn(async move {
            let key = format!("{}\0{}\0{}\0{}", plugin.name, plugin.command, plugin.when.join(","), target.digest);
            let cached = this.cache.lock().unwrap().get(&key).cloned();
            let outcome = match cached {
                Some(produced) => Ok(produced),
                None => runner::run(&this.session, &this.store, &snap, &target, &plugin, &matched).await.map(Arc::new),
            };
            if let Ok(produced) = &outcome {
                this.cache.lock().unwrap().insert(key, produced.clone());
            }
            this.finish(&snap, target, &plugin.name, outcome);
        });
        if let Some(previous) = self.runs.lock().unwrap().insert(name, task.abort_handle()) {
            previous.abort();
        }
    }

    /// Commits a run's outcome, unless a newer snapshot has superseded it.
    fn finish(
        self: &Arc<Self>,
        snap: &Snapshot,
        target: ReportTarget,
        name: &str,
        outcome: Result<Arc<Produced>, Failure>,
    ) {
        {
            let mut state = self.state.lock().unwrap();
            if snap.version != state.version {
                return;
            }
            let Some(stored) = state.generated.get_mut(name) else { return };
            match &outcome {
                Ok(produced) => {
                    stored.title = produced.title.clone();
                    stored.summary = produced.summary.clone();
                    stored.blocks = produced.blocks.clone();
                    stored.status = ReportStatus::Ready;
                    stored.error = None;
                }
                Err(e) => {
                    stored.status = ReportStatus::Failed;
                    stored.error = Some(e.message.clone());
                }
            }
            stored.target = target;
            stored.updated_at = now_ms();
            let log = match &outcome {
                Ok(produced) => produced.log.clone(),
                Err(e) => e.log.clone(),
            };
            state.logs.insert(name.to_owned(), log);
            self.runs.lock().unwrap().remove(name);
        }
        if let Err(e) = &outcome {
            crate::status!("[diffle] report {name}: {}", e.message);
        }
        let this = self.clone();
        tokio::spawn(async move { this.sweep().await });
        self.hub.broadcast(ServerMessage::Reports);
    }

    /// Ends every run in flight.
    pub fn close(&self) {
        for (_, run) in self.runs.lock().unwrap().drain() {
            run.abort();
        }
    }
}
