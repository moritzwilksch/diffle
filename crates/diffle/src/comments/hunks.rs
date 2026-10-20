//! Which lines of a side a unified patch puts on display.
use std::sync::LazyLock;

use regex::Regex;

use crate::protocol::Side;

static HUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").unwrap());

/// Line ranges (1-based, inclusive) of one side that a unified patch shows: each hunk's span,
/// context included. A binary or empty patch shows nothing.
pub fn shown_ranges(patch: &str, side: Side) -> Vec<(i64, i64)> {
    HUNK.captures_iter(patch)
        .filter_map(|m| {
            let (start, count) = match side {
                Side::Old => (m.get(1), m.get(2)),
                Side::New => (m.get(3), m.get(4)),
            };
            let n: i64 = count.map_or(1, |c| c.as_str().parse().unwrap_or(0));
            let s: i64 = start?.as_str().parse().ok()?;
            (n != 0).then_some((s, s + n - 1))
        })
        .collect()
}

/// True when every line of [start, end] lies inside one shown range.
pub fn is_shown(ranges: &[(i64, i64)], start: i64, end: i64) -> bool {
    ranges.iter().any(|&(s, e)| start >= s && end <= e)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,5 @@\n a\n+b\n c\n d\n e\n@@ -20 +21,2 @@ fn()\n x\n+y\n";

    #[test]
    fn reads_each_hunk_span_per_side_defaulting_an_omitted_count_to_one() {
        assert_eq!(shown_ranges(PATCH, Side::Old), [(1, 4), (20, 20)]);
        assert_eq!(shown_ranges(PATCH, Side::New), [(1, 5), (21, 22)]);
    }

    #[test]
    fn shows_nothing_for_an_empty_side_a_binary_patch_or_no_patch() {
        assert!(shown_ranges("@@ -0,0 +1,2 @@\n+a\n+b\n", Side::Old).is_empty());
        assert_eq!(shown_ranges("@@ -0,0 +1,2 @@\n+a\n+b\n", Side::New), [(1, 2)]);
        assert!(shown_ranges("Binary files a/x and b/x differ\n", Side::New).is_empty());
        assert!(shown_ranges("", Side::New).is_empty());
    }

    #[test]
    fn requires_the_whole_range_inside_one_hunk() {
        let r = shown_ranges(PATCH, Side::New);
        assert!(is_shown(&r, 2, 5));
        assert!(!is_shown(&r, 5, 6));
        assert!(!is_shown(&r, 10, 10));
        assert!(is_shown(&r, 22, 22));
    }
}
