//! Ports of the label helpers in `protocol.ts`; the client renders the same strings.
use std::sync::LazyLock;

use regex::Regex;

use super::{ComparisonBase, ModeSpec, RangeSide};

static SESSION_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^refs/diffle/[^/]+/\d+/(?:base|head)/").unwrap());
static BRANCH_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^refs/(?:heads|remotes)/").unwrap());
static FULL_SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40}$").unwrap());

/// A revision as people name it: session PR refs and `refs/heads/` or `refs/remotes/` dropped.
pub fn ref_name(rev: &str) -> String {
    let rev = SESSION_REF.replace(rev, "");
    BRANCH_REF.replace(&rev, "").into_owned()
}

pub fn range_label(old: &str, new: &str) -> String {
    let short = |rev: &str| {
        if FULL_SHA.is_match(rev) { rev[..7].to_owned() } else { ref_name(rev) }
    };
    format!("{}..{}", short(old), short(new))
}

/// The endpoints of a plain comparison, as `comparisonLabel` labels one without a range around it.
pub fn plain_label(old: &str, new: &str, base: ComparisonBase) -> String {
    match base {
        ComparisonBase::Parent => format!("{}^!", short(new)),
        ComparisonBase::MergeBase => format!("{}...{}", ref_name(old), ref_name(new)),
        ComparisonBase::Direct => format!("{}..{}", ref_name(old), ref_name(new)),
    }
}

pub fn comparison_label(mode: &ModeSpec) -> String {
    let Some(within) = &mode.within else {
        return plain_label(&mode.old, &mode.new, mode.base);
    };
    let outer = plain_label(&within.old, &within.new, within.base);
    if let Some(inter) = &mode.interdiff {
        let label = match shown_iterations(&inter.from, &inter.to) {
            Some((from, to)) => format!("{outer} #{from}→#{to}"),
            None => format!("{} → {}", range_label(&inter.from.old, &inter.from.new), side_label(&inter.to)),
        };
        return match &mode.pair {
            Some(pair) => format!("{label} @ {}", short(&pair.new)),
            None => label,
        };
    }
    let at = if mode.new == "worktree" { "worktree".to_owned() } else { short(&mode.new) };
    format!("{outer} @ {at}")
}

fn side_label(side: &RangeSide) -> String {
    range_label(&side.old, &side.new)
}

fn shown_iterations(from: &RangeSide, to: &RangeSide) -> Option<(i64, i64)> {
    Some((from.iteration?, to.iteration?))
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
