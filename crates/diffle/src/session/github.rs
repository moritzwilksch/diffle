//! The active review's pull request: discovered for the client, and the target of exports.
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;

use super::{Session, pr_url};
use crate::error::{GithubError, Result};
use crate::github::client::no_token;
use crate::github::metadata::discover_github;
use crate::github::review::ExportInput;
use crate::protocol::{GithubExportResponse, GithubMetadata, Snapshot, ThreadQuery, ThreadState, same_review};

/// How long one discovery answers for its snapshot before GitHub is asked again.
const DISCOVERY_TTL: Duration = Duration::from_secs(30);

fn changed() -> GithubError {
    GithubError::conflict("Comparison changed; try again")
}

impl Session {
    /// The pull request `snap` belongs to, cached apart from snapshot construction, so callers never
    /// hold the transition queue. A failed lookup is forgotten at once.
    pub async fn github_metadata(self: &Arc<Self>, snap: &Arc<Snapshot>) -> Result<GithubMetadata> {
        let a = self.active()?;
        // The snapshot must be one of the active review's: a discovery answers for one comparison.
        if !same_review(&a.review, &snap.review) {
            return Err(changed().into());
        }
        let task = {
            let mut cached = self.discovered.lock().unwrap();
            match cached.as_ref() {
                Some((at, expires, task)) if Arc::ptr_eq(at, snap) && *expires > Instant::now() => task.clone(),
                _ => {
                    let (this, target, pr_url) = (self.clone(), snap.clone(), pr_url(&a.review));
                    let lookup =
                        async move { discover_github(&this.repo, &target, &this.github, pr_url.as_deref()).await };
                    let task = lookup.boxed().shared();
                    *cached = Some((snap.clone(), Instant::now() + DISCOVERY_TTL, task.clone()));
                    task
                }
            }
        };
        let result = task.clone().await;
        if result.is_err() {
            let mut cached = self.discovered.lock().unwrap();
            if cached.as_ref().is_some_and(|(_, _, t)| t.ptr_eq(&task)) {
                *cached = None;
            }
        }
        result
    }

    /// Adds threads to a pending review on the matching pull request, with fresh pull request data
    /// validated against the current comparison inside the export queue. The human submits it.
    pub async fn export_github(self: &Arc<Self>, thread_ids: Option<Vec<String>>) -> Result<GithubExportResponse> {
        self.exporter
            .export(|| async {
                let a = self.active()?;
                let snap = a.snapshotter.current().await?;
                if !self.is_active(&a) {
                    return Err(changed().into());
                }
                let Some(client) = self.github.client.clone() else {
                    return Err(GithubError::conflict(no_token(&self.github.instance.host)).into());
                };
                let metadata = discover_github(&self.repo, &snap, &self.github, pr_url(&a.review).as_deref()).await?;
                let pull_request = match (metadata.pull_request, metadata.reason) {
                    (Some(pr), None) => pr,
                    (_, reason) => {
                        let reason = reason.unwrap_or_else(|| "No matching pull request".into());
                        return Err(GithubError::conflict(reason).into());
                    }
                };
                if !self.is_active(&a) || !Arc::ptr_eq(&snap, &a.snapshotter.current().await?) {
                    return Err(changed().into());
                }
                let threads = a.comments.threads(&ThreadQuery { state: Some(ThreadState::All), path: None }).await?;
                Ok(ExportInput { new_sha: snap.new_sha.clone(), pull_request, threads, thread_ids, github: client })
            })
            .await
    }
}
