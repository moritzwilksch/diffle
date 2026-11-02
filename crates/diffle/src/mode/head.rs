//! What `HEAD` names in a review while this run holds the checkout.
use std::sync::{Arc, Mutex};

use crate::protocol::{RangeRef, RangeView, Review};

/// Where the reviewer left HEAD, while this run has HEAD elsewhere. A review named after HEAD
/// (`HEAD~6`, `main...HEAD`, `@{u}`) keeps meaning that, so checking out one of its commits does not
/// change which range it shows. Released once HEAD is back or the reviewer moved it: their amend or
/// rebase is then followed as before.
#[derive(Clone, Default)]
pub struct HeadPin(Arc<Mutex<Option<String>>>);

impl HeadPin {
    /// Pins HEAD to `at`, a branch name or a hash; none releases it.
    pub fn set(&self, at: Option<String>) {
        *self.0.lock().unwrap() = at;
    }

    /// `review` with every revision named after HEAD named after the pin instead.
    pub fn apply(&self, review: &Review) -> Review {
        let Some(at) = self.0.lock().unwrap().clone() else { return review.clone() };
        let pin = |rev: &String| pinned(rev, &at).unwrap_or_else(|| rev.clone());
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

/// `rev` relative to `at` in place of HEAD, when it names HEAD: `HEAD`, `HEAD~2`, `HEAD@{u}`, `@`,
/// `@^`, `@{u}`. A branch merely starting with the letters (`HEADER`) is left alone.
fn pinned(rev: &str, at: &str) -> Option<String> {
    let rest = if let Some(rest) = rev.strip_prefix("HEAD") {
        rest
    } else if rev.starts_with("@{") {
        rev
    } else {
        rev.strip_prefix('@')?
    };
    (rest.is_empty() || rest.starts_with(['~', '^', '@'])).then(|| format!("{at}{rest}"))
}

#[cfg(test)]
mod tests {
    use super::pinned;

    #[test]
    fn rewrites_only_names_after_head() {
        let at = |rev| pinned(rev, "feat");
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
}
