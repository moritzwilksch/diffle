//! The review's tour, kept in its comment set beside the threads on it, so a push, a clear, a tick
//! or a new thread is one locked write of one set: a thread can never point into a tour the set no
//! longer holds.
use serde::{Deserialize, Serialize};

use super::store::{CommentStore, new_thread};
use crate::error::{Error, Result};
use crate::protocol::{CommentAnchor, CommentThread, Tour, TourTargetRequest};
use crate::tour::TourIndex;

/// A set's tour as stored: the tour the wire carries, and the reviewer's ticks, which only the
/// checklist items (`TourCheckItem.ticked`) show.
#[derive(Serialize, Deserialize)]
pub struct StoredTour {
    #[serde(flatten)]
    pub tour: Tour,
    /// The questions of its checklists ticked as decided, each as `TourCheckItem.question`: a tour
    /// asks each once, and a push keeps the ticks of the questions it still asks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    ticked: Vec<String>,
}

impl StoredTour {
    pub fn ticked(&self) -> &[String] {
        &self.ticked
    }
}

impl CommentStore {
    /// The set's tour, as last pushed, with its ticks.
    pub async fn tour(&self) -> Result<Option<StoredTour>> {
        Ok(self.read().await?.tour)
    }

    /// Replaces the set's tour, keeping the ticks of the replaced one whose question it still asks,
    /// and moves each thread on the tour to where its passage is now, or marks it stale. Returns the
    /// threads that changed.
    pub async fn push_tour(&self, tour: Tour) -> Result<Vec<String>> {
        let index = TourIndex::read(&tour.html);
        let questions = index.questions();
        self.mutate(|set| {
            let kept = set.tour.take().map(|old| old.ticked).unwrap_or_default();
            let ticked = kept.into_iter().filter(|q| questions.contains(q)).collect();
            set.tour = Some(StoredTour { tour, ticked });
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

    /// Ticks the checklist item asking `question` as decided, or unticks it. Refused when the set has
    /// no tour, or its tour asks no such question.
    pub async fn tick(&self, question: &str, ticked: bool) -> Result<()> {
        self.mutate(|set| {
            let stored = set.tour.as_mut().ok_or_else(|| Error::Invalid("the review has no tour".into()))?;
            if !TourIndex::read(&stored.tour.html).questions().iter().any(|q| q == question) {
                return Err(Error::Invalid(format!("the tour asks no question \"{question}\"")));
            }
            if stored.ticked.iter().any(|q| q == question) == ticked {
                return Ok(((), false));
            }
            if ticked {
                stored.ticked.push(question.to_owned());
            } else {
                stored.ticked.retain(|q| q != question);
            }
            Ok(((), true))
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
            let stored = set.tour.as_ref().ok_or_else(|| Error::Invalid("the review has no tour".into()))?;
            let anchor = TourIndex::read(&stored.tour.html).place(node, target).map_err(Error::Unquotable)?;
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
        let found = index.and_then(|index| index.relocate(node, section, element.tag, target));
        let moved = match found {
            Some(anchor) => {
                let moved = t.stale || anchor != t.anchor;
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
