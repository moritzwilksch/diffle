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

/// Where a patch changes its new side, the lines the language servers read.
#[derive(Debug, Default, PartialEq)]
pub struct NewSideChanges {
    /// Added lines as ranges (1-based, inclusive), ascending.
    pub added: Vec<(i64, i64)>,
    /// For each run of removed lines, the new-side line that now stands where they were.
    pub removed_at: Vec<i64>,
}

impl NewSideChanges {
    /// True when the patch adds or removes anything within [start, end].
    pub fn touches(&self, start: i64, end: i64) -> bool {
        self.added.iter().any(|&(s, e)| s <= end && e >= start)
            || self.removed_at.iter().any(|&l| start <= l && l <= end)
    }

    /// True when every line of [start, end] is added.
    pub fn adds_all(&self, start: i64, end: i64) -> bool {
        self.added.iter().any(|&(s, e)| s <= start && end <= e)
    }
}

/// Reads one file's unified patch. A binary or empty patch changes nothing.
pub fn new_side_changes(patch: &str) -> NewSideChanges {
    let mut changes = NewSideChanges::default();
    // The next new-side line, once inside a hunk.
    let mut next: Option<i64> = None;
    let mut removing = false;
    for line in patch.lines() {
        if let Some(m) = HUNK.captures(line) {
            next = m.get(3).and_then(|s| s.as_str().parse().ok());
            removing = false;
            continue;
        }
        let Some(n) = next.as_mut() else { continue };
        match line.as_bytes().first() {
            Some(b'+') => {
                match changes.added.last_mut() {
                    Some((_, end)) if *end == *n - 1 => *end = *n,
                    _ => changes.added.push((*n, *n)),
                }
                *n += 1;
                removing = false;
            }
            Some(b'-') => {
                if !removing {
                    changes.removed_at.push((*n).max(1));
                }
                removing = true;
            }
            // `\ No newline at end of file` belongs to the line before it.
            Some(b'\\') => {}
            _ => {
                *n += 1;
                removing = false;
            }
        }
    }
    changes
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

    #[test]
    fn reads_added_runs_and_where_removals_were() {
        let patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,6 +1,6 @@\n a\n-b\n-c\n+B\n d\n-e\n f\n+g\n+h\n\\ No newline at end of file\n";
        let changes = new_side_changes(patch);
        assert_eq!(changes, NewSideChanges { added: vec![(2, 2), (5, 6)], removed_at: vec![2, 4] });
        assert!(changes.touches(4, 4) && changes.touches(1, 2) && !changes.touches(3, 3));
        assert!(changes.adds_all(5, 6) && !changes.adds_all(4, 5));
    }

    #[test]
    fn a_new_file_adds_everything_and_a_binary_patch_nothing() {
        assert_eq!(new_side_changes("@@ -0,0 +1,2 @@\n+a\n+b\n").added, [(1, 2)]);
        assert_eq!(new_side_changes("Binary files a/x and b/x differ\n"), NewSideChanges::default());
    }
}
