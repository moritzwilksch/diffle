//! The labels the header shows; the client renders the same strings.
use std::sync::LazyLock;

use regex::Regex;

use super::{ComparisonBase, RangeRef, RangeView, Review, shown_iterations};

static SESSION_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^refs/diffle/[^/]+/\d+/(?:base|head)/").unwrap());
static BRANCH_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^refs/(?:heads|remotes)/").unwrap());
static FULL_SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40}$").unwrap());

/// A revision as people name it: session PR refs and `refs/heads/` or `refs/remotes/` dropped.
pub fn ref_name(rev: &str) -> String {
    let rev = SESSION_REF.replace(rev, "");
    BRANCH_REF.replace(&rev, "").into_owned()
}

/// One side of a range-diff as named, `<old>..<new>`, with full hashes abbreviated.
pub fn range_label(old: &str, new: &str) -> String {
    let short = |rev: &str| {
        if FULL_SHA.is_match(rev) { rev[..7].to_owned() } else { ref_name(rev) }
    };
    format!("{}..{}", short(old), short(new))
}

/// The endpoints of a range, as `comparisonLabel` labels one shown whole.
pub fn plain_label(old: &str, new: &str, base: ComparisonBase) -> String {
    match base {
        ComparisonBase::MergeBase => format!("{}...{}", ref_name(old), ref_name(new)),
        ComparisonBase::Direct => format!("{}..{}", ref_name(old), ref_name(new)),
    }
}

/// How the header names a review, as the client labels it too.
pub fn comparison_label(review: &Review) -> String {
    let Review::Range { old, new, base, view, .. } = review else {
        let Review::Commit { sha } = review else { unreachable!() };
        return format!("{}^!", short(sha));
    };
    let range = plain_label(old, new, *base);
    match view {
        RangeView::Whole => range,
        RangeView::Commit { sha } => format!("{range} @ {}", short(sha)),
        RangeView::Uncommitted => format!("{range} @ worktree"),
        RangeView::Interdiff { from, to, pair } => {
            let side = |r: Option<&RangeRef>| match r {
                None => range.clone(),
                Some(RangeRef::Iteration { n }) => format!("#{n}"),
                Some(RangeRef::Named { old, new }) => range_label(old, new),
            };
            let label = match shown_iterations(review) {
                Some((from, to)) => format!("{range} #{from}→#{to}"),
                None => format!("{} → {}", side(Some(from)), side(to.as_ref())),
            };
            match pair {
                Some(sha) => format!("{label} @ {}", short(sha)),
                None => label,
            }
        }
    }
}

fn short(rev: &str) -> String {
    rev.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_refs_as_people_do() {
        assert_eq!(ref_name("refs/diffle/abc/12/head/feat/x"), "feat/x");
        assert_eq!(ref_name("refs/remotes/origin/main"), "origin/main");
        assert_eq!(plain_label("refs/heads/main", "HEAD", ComparisonBase::MergeBase), "main...HEAD");
        assert_eq!(range_label(&"a".repeat(40), "main"), "aaaaaaa..main");
    }
}
