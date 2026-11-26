//! GitHub metadata and permalinks for the active comparison.
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt;

use super::{Session, pr_url};
use crate::error::{GithubError, Result};
use crate::github::metadata::discover_github;
use crate::github::permalink::permalink;
use crate::protocol::{GithubMetadata, Permalink, PermalinkRequest, Snapshot};

/// How long one discovery answers for its snapshot before GitHub is asked again.
const DISCOVERY_TTL: Duration = Duration::from_secs(30);

impl Session {
    /// The pull request `snap` belongs to, cached apart from snapshot construction, so callers never
    /// hold the transition queue. A failed lookup is forgotten at once.
    pub async fn github_metadata(self: &Arc<Self>, snap: &Arc<Snapshot>) -> Result<GithubMetadata> {
        let a = self.active()?;
        // The snapshot must be one of the active review's: a discovery answers for one comparison.
        if a.review != snap.review {
            return Err(GithubError::conflict("Comparison changed; try again").into());
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

    /// The link to lines of the current snapshot, read afresh from local refs on every call.
    pub async fn permalink(&self, req: &PermalinkRequest) -> Result<Permalink> {
        let snap = self.snapshotter()?.current().await?;
        permalink(&self.repo, &snap, &self.github.instance, req).await
    }
}
