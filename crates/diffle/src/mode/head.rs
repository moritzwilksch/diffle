//! What `HEAD` names in a review while this run holds the checkout.
use std::sync::{Arc, Mutex};

use crate::protocol::{RangeRef, RangeView, Review};

/// Where the reviewer left HEAD, while this run has HEAD elsewhere. A review named after HEAD
/// (`HEAD~6`, `main...HEAD`, `@{u}`, `@{-1}`) keeps meaning that, so checking out one of its
/// commits does not change which range it shows. Released once HEAD is back or the reviewer moved
/// it: their amend or rebase is then followed as before.
#[derive(Clone, Default)]
pub struct HeadPin(Arc<Mutex<Option<Held>>>);

/// Where the reviewer left HEAD, and how many switches this run made since, each one an entry
/// `@{-N}` counts.
#[derive(Clone)]
struct Held {
    at: String,
    switches: u32,
}

impl HeadPin {
    /// Pins HEAD to `at`, a branch name or a hash, after one more switch this run made.
    pub fn hold(&self, at: String) {
        let mut held = self.0.lock().unwrap();
        let switches = held.as_ref().map_or(0, |h| h.switches) + 1;
        *held = Some(Held { at, switches });
    }

    /// HEAD names HEAD again.
    pub fn release(&self) {
        *self.0.lock().unwrap() = None;
    }

    /// `review` with every revision named after HEAD named after the pin instead.
    pub fn apply(&self, review: &Review) -> Review {
        let Some(held) = self.0.lock().unwrap().clone() else { return review.clone() };
        let pin = |rev: &String| pinned(rev, &held).unwrap_or_else(|| rev.clone());
        match review {
            Review::Commit { sha } => Review::Commit { sha: pin(sha) },
            Review::Range { old, new, base, pr, view } => {
                let side = |side: &RangeRef| match side {
                    RangeRef::Named { old, new } => RangeRef::Named { old: pin(old), new: pin(new) },
                    iteration => iteration.clone(),
                };
                let view = match view {
                    RangeView::Interdiff { from, to, pair } => {
                        RangeView::Interdiff { from: side(from), to: to.as_ref().map(side), pair: pair.clone() }
                    }
                    view => view.clone(),
                };
                Review::Range { old: pin(old), new: pin(new), base: *base, pr: pr.clone(), view }
            }
        }
    }
}

/// `rev` as the reviewer meant it, when it names HEAD: `HEAD`, `HEAD~2`, `HEAD@{u}`, `@`, `@^`,
/// `@{u}` relative to where they left HEAD; `@{-N}`, the Nth branch checked out before, past the
/// switches this run made since. A branch merely starting with the letters (`HEADER`) is left alone.
fn pinned(rev: &str, held: &Held) -> Option<String> {
    if let Some((n, rest)) = rev.strip_prefix("@{-").and_then(|r| r.split_once('}')) {
        let n: u32 = n.parse().ok()?;
        return Some(format!("@{{-{}}}{rest}", n + held.switches));
    }
    let rest = if let Some(rest) = rev.strip_prefix("HEAD") {
        rest
    } else if rev.starts_with("@{") {
        rev
    } else {
        rev.strip_prefix('@')?
    };
    (rest.is_empty() || rest.starts_with(['~', '^', '@'])).then(|| format!("{}{rest}", held.at))
}

#[cfg(test)]
mod tests {
    use super::{Held, pinned};

    #[test]
    fn rewrites_only_names_after_head() {
        let held = Held { at: "feat".to_owned(), switches: 1 };
        let at = |rev| pinned(rev, &held);
        assert_eq!(at("HEAD").as_deref(), Some("feat"));
        assert_eq!(at("HEAD~6").as_deref(), Some("feat~6"));
        assert_eq!(at("HEAD^2").as_deref(), Some("feat^2"));
        assert_eq!(at("HEAD@{u}").as_deref(), Some("feat@{u}"));
        assert_eq!(at("@").as_deref(), Some("feat"));
        assert_eq!(at("@~1").as_deref(), Some("feat~1"));
        assert_eq!(at("@{u}").as_deref(), Some("feat@{u}"));
        assert_eq!(at("HEADER"), None);
        assert_eq!(at("main"), None);
        assert_eq!(at("worktree"), None);
    }

    #[test]
    fn counts_previous_branches_past_this_runs_switches() {
        let held = Held { at: "main".to_owned(), switches: 2 };
        let at = |rev| pinned(rev, &held);
        assert_eq!(at("@{-1}").as_deref(), Some("@{-3}"));
        assert_eq!(at("@{-2}~1").as_deref(), Some("@{-4}~1"));
        // Not a number: git rejects it, so it is left for git to word.
        assert_eq!(at("@{-x}"), None);
    }
}
