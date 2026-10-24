//! The bounds of one graph build: how much it asks, how long it waits, when it stops.
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::time::Instant;

use super::settle::Patience;

/// Changed symbols asked for references; past it the graph says so and stops.
pub const MAX_SYMBOLS: usize = 4000;
/// Everything one build may take, however many queries are left: past it the graph is assembled
/// from what was gathered and says so.
pub const BUILD_DEADLINE: Duration = Duration::from_secs(60);

/// The bounds of one build.
pub struct Limits {
    pub symbols: usize,
    pub patience: Patience,
    pub deadline: Duration,
}

impl Limits {
    pub const DEFAULT: Self = Self { symbols: MAX_SYMBOLS, patience: Patience::DEFAULT, deadline: BUILD_DEADLINE };
}

/// The instant a build stops asking. Each query runs `within` it, so the state gathered so far
/// is intact when it passes.
pub struct Deadline {
    at: Instant,
    budget: Duration,
    hit: AtomicBool,
}

impl Deadline {
    pub fn new(budget: Duration) -> Self {
        Self { at: Instant::now() + budget, budget, hit: AtomicBool::new(false) }
    }

    pub fn at(&self) -> Instant {
        self.at
    }

    pub fn budget(&self) -> Duration {
        self.budget
    }

    /// The work's output, or none when the deadline had passed or passes before it finishes.
    pub async fn within<F: Future>(&self, work: F) -> Option<F::Output> {
        if Instant::now() >= self.at {
            self.hit.store(true, Ordering::Relaxed);
            return None;
        }
        let done = tokio::time::timeout_at(self.at, work).await.ok();
        if done.is_none() {
            self.hit.store(true, Ordering::Relaxed);
        }
        done
    }

    /// Whether some work was cut short or skipped.
    pub fn was_hit(&self) -> bool {
        self.hit.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn work_that_finishes_in_time_is_returned_and_leaves_the_deadline_unhit() {
        let deadline = Deadline::new(Duration::from_secs(5));
        assert_eq!(deadline.within(async { 7 }).await, Some(7));
        assert!(!deadline.was_hit());
    }

    #[tokio::test]
    async fn work_that_outlasts_the_deadline_is_cut_and_marks_it() {
        let deadline = Deadline::new(Duration::from_millis(20));
        let slow = tokio::time::sleep(Duration::from_secs(30));
        assert_eq!(deadline.within(slow).await, None);
        assert!(deadline.was_hit());
    }

    #[tokio::test]
    async fn work_started_after_the_deadline_never_runs() {
        let deadline = Deadline::new(Duration::ZERO);
        let ran = std::sync::atomic::AtomicBool::new(false);
        let work = async { ran.store(true, Ordering::Relaxed) };
        assert_eq!(deadline.within(work).await, None);
        assert!(!ran.load(Ordering::Relaxed) && deadline.was_hit());
    }
}
