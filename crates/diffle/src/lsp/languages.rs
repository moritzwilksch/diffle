//! A file's language by the snapshot the pool last tracked: a Helm template needs its chart's
//! `Chart.yaml` in the tree beside it.
use std::sync::{Arc, Mutex};

use crate::protocol::{LanguageId, Snapshot, language_of};

/// Shared by the pool and every server's documents; each tracked snapshot replaces the one before.
#[derive(Clone, Default)]
pub struct Languages(Arc<Mutex<Option<Arc<Snapshot>>>>);

impl Languages {
    pub fn follow(&self, snap: &Arc<Snapshot>) {
        *self.0.lock().unwrap() = Some(snap.clone());
    }

    /// `language_of` over the last tracked snapshot's new side; by name alone before the first.
    pub fn of(&self, path: &str) -> Option<LanguageId> {
        let snap = self.0.lock().unwrap().clone();
        language_of(path, snap.as_deref().map_or(&[], |s| &s.tree))
    }
}
