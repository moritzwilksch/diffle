//! Threads on the review's tour, which a push moves and a clear makes stale.
use super::store::CommentStore;
use crate::error::Result;
use crate::protocol::{CommentAnchor, TourTarget};

impl CommentStore {
    /// Moves each tour thread to where `find` places its passage now, or marks it stale where `find`
    /// finds none, keeping its anchor. Returns the threads that changed.
    pub async fn relocate_tour(
        &self,
        find: impl Fn(&[i64], &str, &str, &TourTarget) -> Option<CommentAnchor>,
    ) -> Result<Vec<String>> {
        self.mutate(|set| {
            let mut changed = Vec::new();
            for t in &mut set.threads {
                let CommentAnchor::Tour { node, section, element, target, .. } = &t.anchor else { continue };
                let found = find(node, section, element, target);
                let moved = match found {
                    Some(anchor) => {
                        let moved = t.stale || !same(&anchor, &t.anchor);
                        (t.anchor, t.stale) = (anchor, false);
                        moved
                    }
                    None => !std::mem::replace(&mut t.stale, true),
                };
                if moved {
                    changed.push(t.id.clone());
                }
            }
            let any = !changed.is_empty();
            Ok((changed, any))
        })
        .await
    }
}

/// Whether two anchors name the same place; the generated types carry no `PartialEq`.
fn same(a: &CommentAnchor, b: &CommentAnchor) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}
