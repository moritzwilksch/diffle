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
    /// For each run of removed lines, the new-side line it belongs to: the one now standing where
    /// they were, or the one above when they sat deeper than it, a block's trailing statements.
    pub removed_at: Vec<i64>,
    /// Each run of added lines with its new-side line numbers and text, for matching moved code.
    pub added_runs: Vec<Vec<(i64, String)>>,
    /// Each run of removed lines' text, parallel to `removed_at`.
    pub removed_runs: Vec<Vec<String>>,
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
    // What the previous line did, so a run continues or a new one starts.
    let mut last = b' ';
    // The last removed run awaiting the next non-blank new-side line, by index, with its indent.
    let mut pending: Option<(usize, Option<usize>)> = None;
    for line in patch.lines() {
        if let Some(m) = HUNK.captures(line) {
            settle(&mut changes, pending.take(), 0);
            next = m.get(3).and_then(|s| s.as_str().parse().ok());
            last = b' ';
            continue;
        }
        // A patch of several files: the next file's header is no line of this hunk.
        if line.starts_with("diff --git ") {
            settle(&mut changes, pending.take(), 0);
            next = None;
            continue;
        }
        let Some(n) = next.as_mut() else { continue };
        let text = line.get(1..).unwrap_or_default().to_owned();
        let depth = indent(&text);
        match line.as_bytes().first() {
            // A run's depth is its first non-blank line's.
            Some(b'-') if last == b'-' => {
                if let Some((_, run @ None)) = pending.as_mut() {
                    *run = depth;
                }
            }
            Some(b'+' | b' ') if depth.is_some() => settle(&mut changes, pending.take(), depth.unwrap()),
            _ => {}
        }
        match line.as_bytes().first() {
            Some(b'+') => {
                match changes.added.last_mut() {
                    Some((_, end)) if *end == *n - 1 => *end = *n,
                    _ => changes.added.push((*n, *n)),
                }
                if last != b'+' {
                    changes.added_runs.push(Vec::new());
                }
                changes.added_runs.last_mut().unwrap().push((*n, text));
                *n += 1;
                last = b'+';
            }
            Some(b'-') => {
                if last != b'-' {
                    settle(&mut changes, pending.take(), 0);
                    pending = Some((changes.removed_at.len(), depth));
                    changes.removed_at.push((*n).max(1));
                    changes.removed_runs.push(Vec::new());
                }
                changes.removed_runs.last_mut().unwrap().push(text);
                last = b'-';
            }
            // `\ No newline at end of file` belongs to the line before it.
            Some(b'\\') => {}
            _ => {
                *n += 1;
                last = b' ';
            }
        }
    }
    settle(&mut changes, pending, 0);
    changes
}

/// Moves a removed run onto the line above it when it sat deeper than `below`, the indent of the
/// next line standing after it (0 past the hunk): it ended the block above, as a trailing statement does.
fn settle(changes: &mut NewSideChanges, run: Option<(usize, Option<usize>)>, below: usize) {
    if let Some((i, Some(depth))) = run
        && depth > below
    {
        changes.removed_at[i] = (changes.removed_at[i] - 1).max(1);
    }
}

/// A line's leading whitespace, or None for a blank line.
fn indent(text: &str) -> Option<usize> {
    let body = text.trim_start();
    (!body.is_empty()).then(|| text.len() - body.len())
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
    fn puts_a_block_s_removed_trailing_lines_on_the_line_above_and_a_removed_block_below() {
        let tail = "@@ -1,4 +1,3 @@\n def f():\n     a()\n-    b()\n \n";
        assert_eq!(new_side_changes(tail).removed_at, [2]);
        let at_eof = "@@ -1,3 +1,2 @@\n def f():\n     a()\n-    b()\n";
        assert_eq!(new_side_changes(at_eof).removed_at, [2]);
        let block = "@@ -1,5 +1,2 @@\n x = 1\n-\n-def g():\n-    pass\n def h():\n";
        assert_eq!(new_side_changes(block).removed_at, [2]);
    }

    #[test]
    fn reads_added_runs_and_where_removals_were() {
        let patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,6 +1,6 @@\n a\n-b\n-c\n+B\n d\n-e\n f\n+g\n+h\n\\ No newline at end of file\n";
        let changes = new_side_changes(patch);
        assert_eq!((&changes.added, &changes.removed_at), (&vec![(2, 2), (5, 6)], &vec![2, 4]));
        assert_eq!(changes.added_runs, [vec![(2, "B".to_owned())], vec![(5, "g".to_owned()), (6, "h".to_owned())]]);
        assert_eq!(changes.removed_runs, [vec!["b".to_owned(), "c".to_owned()], vec!["e".to_owned()]]);
        assert!(changes.touches(4, 4) && changes.touches(1, 2) && !changes.touches(3, 3));
        assert!(changes.adds_all(5, 6) && !changes.adds_all(4, 5));
    }

    #[test]
    fn reads_no_file_header_of_a_later_file_as_lines() {
        let two = "@@ -1 +1 @@\n-a\n+b\ndiff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-c\n+d\n";
        let changes = new_side_changes(two);
        assert_eq!(changes.added_runs, [vec![(1, "b".to_owned())], vec![(1, "d".to_owned())]]);
        assert_eq!(changes.removed_runs, [vec!["a".to_owned()], vec!["c".to_owned()]]);
    }

    #[test]
    fn a_new_file_adds_everything_and_a_binary_patch_nothing() {
        assert_eq!(new_side_changes("@@ -0,0 +1,2 @@\n+a\n+b\n").added, [(1, 2)]);
        assert_eq!(new_side_changes("Binary files a/x and b/x differ\n"), NewSideChanges::default());
    }
}
