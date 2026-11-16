//! Coalescing the pool's status: a burst of changes is one broadcast now and one trailing it.
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::LspPool;

/// A status change goes out at once when the pool has been quiet, and later ones within this
/// window ride on one trailing publish: a server logging a hundred stderr lines while indexing is a
/// few broadcasts, not a hundred.
const PUBLISH_WINDOW: Duration = Duration::from_millis(20);

#[derive(Default)]
pub(super) struct Publish {
    pending: bool,
    due: bool,
}

impl LspPool {
    pub(super) fn publish(self: &Arc<Self>) {
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut publish = self.publish.lock().unwrap();
            if publish.pending {
                publish.due = true;
                return;
            }
            publish.pending = true;
        }
        (self.opts.on_status)(self.status());
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(PUBLISH_WINDOW).await;
            let Some(pool) = weak.upgrade() else { return };
            let due = {
                let mut publish = pool.publish.lock().unwrap();
                publish.pending = false;
                std::mem::take(&mut publish.due)
            };
            if due {
                pool.publish();
            }
        });
    }
}
