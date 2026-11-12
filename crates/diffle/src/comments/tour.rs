//! The review's tour, kept in its comment set beside the threads on it, so a push, a clear, a tick
//! or a new thread is one locked write of one set: a thread can never point into a tour the set no
//! longer holds.
use super::store::{CommentStore, new_thread};
use crate::error::{Error, Result};
use crate::protocol::{CommentAnchor, CommentThread, Tour, TourTargetRequest};
use crate::tour::TourIndex;

impl CommentStore {
    /// The set's tour, as last pushed.
    pub async fn tour(&self) -> Result<Option<Tour>> {
        Ok(self.read().await?.tour)
    }

    /// Replaces the set's tour, keeping the ticks of the replaced one whose question it still asks,
    /// and moves each thread on the tour to where its passage is now, or marks it stale. Returns the
    /// threads that changed.
    pub async fn push_tour(&self, mut tour: Tour) -> Result<Vec<String>> {
        let index = TourIndex::read(&tour.html);
        let questions: Vec<String> = index.checks(&[]).into_iter().map(|item| item.question).collect();
        self.mutate(|set| {
            let kept = set.tour.take().map(|old| old.ticked).unwrap_or_default();
            tour.ticked = kept.into_iter().filter(|q| questions.contains(q)).collect();
            set.tour = Some(tour);
            Ok((relocate(&mut set.threads, Some(&index)), true))
        })
        .await
    }

    /// Removes the set's tour and marks every thread on it stale; none when there was no tour.
    pub async fn clear_tour(&self) -> Result<Option<Vec<String>>> {
        self.mutate(|set| match set.tour.take() {
            Some(_) => Ok((Some(relocate(&mut set.threads, None)), true)),
            None => Ok((None, false)),
        })
        .await
    }

    /// Ticks the checklist item asking `question` as decided, or unticks it; false when the set has
    /// no tour.
    pub async fn tick(&self, question: &str, ticked: bool) -> Result<bool> {
        self.mutate(|set| {
            let Some(tour) = set.tour.as_mut() else { return Ok((false, false)) };
            if tour.ticked.iter().any(|q| q == question) == ticked {
                return Ok((true, false));
            }
            if ticked {
                tour.ticked.push(question.to_owned());
            } else {
                tour.ticked.retain(|q| q != question);
            }
            Ok((true, true))
        })
        .await
    }

    /// Opens a thread on `target` at `node` of the tour the set holds as it writes it.
    pub async fn add_tour_thread(
        &self,
        node: &[i64],
        target: &TourTargetRequest,
        body: String,
    ) -> Result<CommentThread> {
        self.mutate(|set| {
            let tour = set.tour.as_ref().ok_or_else(|| Error::Invalid("the review has no tour".into()))?;
            let anchor = TourIndex::read(&tour.html).place(node, target).map_err(Error::Unquotable)?;
            let t = new_thread(anchor, body, None);
            set.threads.push(t.clone());
            Ok((t, true))
        })
        .await
    }
}

/// Moves each thread on the tour to where `index` places its passage now, or marks it stale where it
/// finds none (or there is no tour), keeping its anchor. Returns the threads that changed.
fn relocate(threads: &mut [CommentThread], index: Option<&TourIndex>) -> Vec<String> {
    let mut changed = Vec::new();
    for t in threads {
        let CommentAnchor::Tour { node, section, element, target, .. } = &t.anchor else { continue };
        let found = index.and_then(|index| index.relocate(node, section, &element.tag, target));
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
    changed
}

/// Whether two anchors name the same place; the generated types carry no `PartialEq`.
fn same(a: &CommentAnchor, b: &CommentAnchor) -> bool {
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}
