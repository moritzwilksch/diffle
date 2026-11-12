//! The review's tour, kept in its comment set, so each review keeps its own.
use super::store::CommentStore;
use crate::error::Result;
use crate::protocol::Tour;

impl CommentStore {
    /// The set's tour, as last pushed.
    pub async fn tour(&self) -> Result<Option<Tour>> {
        Ok(self.read().await?.tour)
    }

    /// Replaces the set's tour.
    pub async fn push_tour(&self, tour: Tour) -> Result<()> {
        self.mutate(|set| {
            set.tour = Some(tour);
            Ok(((), true))
        })
        .await
    }

    /// Removes the set's tour; false when there was none.
    pub async fn clear_tour(&self) -> Result<bool> {
        self.mutate(|set| {
            let had = set.tour.take().is_some();
            Ok((had, had))
        })
        .await
    }
}
