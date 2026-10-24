//! A patch's changed lines and the outline symbols they fall in.
//!
//! A symbol is located by its name line (the server's selection range), not by its full range
//! start: a change confined to a decorator, `#[derive]` or `@Override` above it lands in no symbol.
use std::collections::{BTreeSet, HashMap};

use super::moved::{Edits, Print, Run, Side};
use crate::protocol::LspSymbol;

/// LSP SymbolKind numbers that make a node wherever they sit: module, namespace, class, method,
/// constructor, enum, interface, function, object and struct.
const NESTABLE_KINDS: [i64; 10] = [2, 3, 5, 6, 9, 10, 11, 12, 19, 23];
/// Variable and constant: a node only at the top level, since locals are noise.
const TOP_LEVEL_KINDS: [i64; 2] = [13, 14];

const HUNK_MARKER: &str = "@@";
const FILE_MARKER: &str = "diff --git ";
const ADDED_PATH: &str = "+++ b/";
const RENAMED_TO: &str = "rename to ";

/// Where a patch parse stands: before the first hunk, or inside one at a new-side line.
#[derive(Clone, Copy)]
enum Cursor {
    Header,
    Hunk(u32),
}

/// A unified patch as runs of consecutive added or removed lines, each with the new-side line it
/// marks: every added line its own, and for removed lines the new-side line now at their position,
/// so a pure deletion still points at code.
pub fn edits(patch: &str) -> Edits {
    let mut edits = Edits::default();
    let mut open: Option<Run> = None;
    let mut cursor = Cursor::Header;
    for row in patch.lines() {
        if row.starts_with(HUNK_MARKER) {
            close(&mut open, &mut edits);
            cursor = new_start(row).map_or(Cursor::Header, Cursor::Hunk);
            continue;
        }
        let Cursor::Hunk(next) = cursor else { continue };
        let text = row.get(1..).unwrap_or_default();
        cursor = match row.as_bytes().first() {
            Some(b'+') => {
                extend(&mut open, &mut edits, Side::Added, next, text);
                Cursor::Hunk(next.saturating_add(1))
            }
            Some(b'-') => {
                extend(&mut open, &mut edits, Side::Removed, next, text);
                cursor
            }
            Some(b' ') | None => {
                close(&mut open, &mut edits);
                Cursor::Hunk(next.saturating_add(1))
            }
            // `\ No newline at end of file` belongs to the line before it.
            Some(_) => cursor,
        };
    }
    close(&mut open, &mut edits);
    edits
}

/// Adds a line to the open run, or starts a run of `side` at `at` when the open one is the other side's.
fn extend(open: &mut Option<Run>, edits: &mut Edits, side: Side, at: u32, text: &str) {
    if open.as_ref().is_some_and(|run| run.side != side) {
        close(open, edits);
    }
    open.get_or_insert_with(|| Run { side, first: at, prints: Vec::new() }).prints.push(Print::of(text));
}

fn close(open: &mut Option<Run>, edits: &mut Edits) {
    if let Some(run) = open.take() {
        edits.push(run);
    }
}

/// The edits of each file a multi-file patch names. A file whose path the headers do not give
/// plainly (a C-quoted name) is left out: the caller asks for it alone.
pub fn edits_by_file(patch: &str) -> HashMap<String, Edits> {
    let starts = std::iter::once(0)
        .filter(|_| patch.starts_with(FILE_MARKER))
        .chain(patch.match_indices(&format!("\n{FILE_MARKER}")).map(|(i, _)| i + 1))
        .collect::<Vec<_>>();
    let ends = starts.iter().skip(1).copied().chain(std::iter::once(patch.len()));
    starts
        .iter()
        .zip(ends)
        .filter_map(|(&from, to)| {
            let block = &patch[from..to];
            Some((block_path(block)?, edits(block)))
        })
        .collect()
}

/// The new-side path of one file's block: its `+++` line, else its rename target, else the
/// header of a block with no hunks (`diff --git a/P b/P`).
fn block_path(block: &str) -> Option<String> {
    let plain = |p: &str| (!p.starts_with('"')).then(|| p.trim_end_matches('\t').to_owned());
    let before_hunks = block.lines().take_while(|l| !l.starts_with(HUNK_MARKER));
    let mut header = None;
    for row in before_hunks {
        if let Some(path) = row.strip_prefix(ADDED_PATH).or_else(|| row.strip_prefix(RENAMED_TO)) {
            return plain(path);
        }
        header.get_or_insert(row);
    }
    let names = header?.strip_prefix(FILE_MARKER)?.strip_prefix("a/")?;
    let mid = names.len().checked_sub(3)? / 2;
    let (old, new) = (names.get(..mid)?, names.get(mid..)?.strip_prefix(" b/")?);
    (old == new).then(|| plain(new)).flatten()
}

/// The new-side start of an `@@ -a,b +c,d @@` header; `None` for a header git never wrote.
fn new_start(header: &str) -> Option<u32> {
    let plus = header.split_whitespace().find(|part| part.starts_with('+'))?;
    plus[1..].split(',').next()?.parse().ok()
}

/// Whether a symbol is worth a node in the graph.
fn is_graphable(symbol: &LspSymbol) -> bool {
    match (NESTABLE_KINDS.contains(&symbol.kind), TOP_LEVEL_KINDS.contains(&symbol.kind), symbol.container.is_none()) {
        (true, _, _) => true,
        (false, true, top_level) => top_level,
        (false, false, _) => false,
    }
}

/// Answers "which graphable symbol of this outline contains line L most tightly" in O(log n):
/// the smallest span, and of equal spans the one starting later (then the earlier in the outline).
/// Built once per outline by sweeping the symbols' boundaries, so it holds for overlapping spans too.
#[derive(Default)]
pub struct Spans {
    /// `(first line, owner)`: the owner holds from that line until the next entry's.
    segments: Vec<(i64, Option<usize>)>,
}

impl Spans {
    pub fn new(outline: &[LspSymbol]) -> Self {
        let spans: Vec<usize> = (0..outline.len())
            .filter(|&i| is_graphable(&outline[i]) && outline[i].line <= outline[i].end_line)
            .collect();
        let mut by_start = spans.clone();
        by_start.sort_by_key(|&i| (outline[i].line, i));
        let mut by_end = spans;
        by_end.sort_by_key(|&i| (outline[i].end_line, i));
        let mut bounds: Vec<i64> =
            by_start.iter().flat_map(|&i| [outline[i].line, outline[i].end_line.saturating_add(1)]).collect();
        bounds.sort_unstable();
        bounds.dedup();
        let tightness = |i: usize| (outline[i].end_line - outline[i].line, std::cmp::Reverse(outline[i].line), i);
        let (mut open, mut closed) = (0, 0);
        let mut active = BTreeSet::new();
        let mut segments: Vec<(i64, Option<usize>)> = Vec::new();
        for at in bounds {
            while closed < by_end.len() && outline[by_end[closed]].end_line.saturating_add(1) <= at {
                active.remove(&tightness(by_end[closed]));
                closed += 1;
            }
            while open < by_start.len() && outline[by_start[open]].line <= at {
                active.insert(tightness(by_start[open]));
                open += 1;
            }
            let owner = active.first().map(|&(_, _, i)| i);
            if segments.last().is_none_or(|&(_, last)| last != owner) {
                segments.push((at, owner));
            }
        }
        Self { segments }
    }

    /// The index in the outline of the symbol holding `line`, if any.
    pub fn at(&self, line: u32) -> Option<usize> {
        let line = i64::from(line);
        let after = self.segments.partition_point(|&(from, _)| from <= line);
        after.checked_sub(1).and_then(|i| self.segments[i].1)
    }
}

/// The graphable symbols that contain at least one of `lines`, each once, in outline order.
pub fn changed_symbols<'a>(outline: &'a [LspSymbol], lines: &BTreeSet<u32>) -> Vec<&'a LspSymbol> {
    let spans = Spans::new(outline);
    let hit: BTreeSet<usize> = lines.iter().filter_map(|&l| spans.at(l)).collect();
    hit.into_iter().map(|i| &outline[i]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::moved::{Side, unmoved};
    use crate::protocol::LspSymbol;

    /// The lines a patch changes on its own, as the graph would take them.
    fn lines(patch: &str) -> Vec<u32> {
        unmoved(&[&edits(patch)]).remove(0).into_iter().collect()
    }

    /// The runs of a patch as `(+ or -, first line, how many lines)`.
    fn shape(patch: &str) -> Vec<(char, u32, usize)> {
        let sign = |side| if side == Side::Added { '+' } else { '-' };
        edits(patch).runs().iter().map(|r| (sign(r.side), r.first, r.prints.len())).collect()
    }

    fn sym(name: &str, kind: i64, line: i64, end_line: i64, container: Option<&str>) -> LspSymbol {
        LspSymbol {
            name: name.into(),
            kind,
            container: container.map(Into::into),
            path: "a.rs".into(),
            line,
            end_line,
            col: 0,
        }
    }

    fn names(found: &[&LspSymbol]) -> Vec<String> {
        found.iter().map(|s| s.name.clone()).collect()
    }

    #[test]
    fn added_lines_are_new_side_numbers() {
        let patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n one\n+two\n three\n+four\n";
        assert_eq!(lines(patch), [2, 4]);
    }

    #[test]
    fn a_pure_deletion_marks_the_next_new_side_line() {
        let patch = "@@ -1,4 +1,3 @@\n one\n-two\n three\n four\n";
        assert_eq!(lines(patch), [2]);
    }

    #[test]
    fn a_replacement_marks_the_added_line_and_not_twice() {
        let patch = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
        assert_eq!(lines(patch), [2]);
    }

    #[test]
    fn several_hunks_restart_at_their_own_header() {
        let patch = "@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -20,3 +21,2 @@\n x\n-y\n z\n";
        assert_eq!(lines(patch), [2, 22]);
    }

    #[test]
    fn a_brand_new_file_is_all_added() {
        let patch = "diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
        assert_eq!(lines(patch), [1, 2, 3]);
    }

    #[test]
    fn a_header_looking_deletion_inside_a_hunk_is_a_deletion() {
        let patch = "@@ -1,2 +1,1 @@\n keep\n--- not a header\n";
        assert_eq!(lines(patch), [2]);
    }

    #[test]
    fn no_newline_markers_do_not_count() {
        let patch = "@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+TWO\n\\ No newline at end of file\n";
        assert_eq!(lines(patch), [2]);
    }

    #[test]
    fn runs_split_where_context_or_the_other_side_comes_between() {
        let patch = "@@ -1,7 +1,7 @@\n a\n-b\n-c\n+B\n+C\n d\n+e\n f\n-g\n";
        assert_eq!(shape(patch), [('-', 2, 2), ('+', 2, 2), ('+', 5, 1), ('-', 7, 1)]);
    }

    #[test]
    fn a_no_newline_marker_does_not_cut_a_run() {
        let patch =
            "@@ -1,2 +1,2 @@\n-one\n-two\n\\ No newline at end of file\n+uno\n+dos\n\\ No newline at end of file\n";
        assert_eq!(shape(patch), [('-', 1, 2), ('+', 1, 2)]);
    }

    #[test]
    fn a_runs_lines_are_fingerprinted_by_their_trimmed_text() {
        let patch = "@@ -1,1 +1,1 @@\n-    let x = compute(1);\n+let x = compute(1);\n";
        let got = edits(patch);
        assert_eq!(got.runs()[0].prints, got.runs()[1].prints);
    }

    #[test]
    fn a_patch_without_hunks_changes_nothing() {
        assert!(lines("Binary files a/x and b/x differ\n").is_empty());
        assert!(lines("").is_empty());
    }

    #[test]
    fn only_symbol_kinds_that_graph_are_kept() {
        let outline: Vec<LspSymbol> = [1, 2, 3, 5, 6, 9, 10, 11, 12, 19, 23, 8, 13, 14, 26]
            .iter()
            .enumerate()
            .map(|(i, k)| sym(&format!("s{k}"), *k, 1 + 10 * i as i64, 5 + 10 * i as i64, None))
            .collect();
        let touched: BTreeSet<u32> = outline.iter().map(|s| s.line as u32).collect();
        let kept: Vec<i64> = changed_symbols(&outline, &touched).iter().map(|s| s.kind).collect();
        assert_eq!(kept, [2, 3, 5, 6, 9, 10, 11, 12, 19, 23, 13, 14]);
    }

    #[test]
    fn variables_and_constants_need_no_container() {
        let outline = [
            sym("top", 13, 1, 2, None),
            sym("inner", 13, 3, 3, Some("f")),
            sym("topc", 14, 5, 5, None),
            sym("innerc", 14, 6, 6, Some("f")),
            sym("method", 6, 8, 9, Some("C")),
        ];
        let touched = BTreeSet::from([1, 3, 5, 6, 8]);
        assert_eq!(names(&changed_symbols(&outline, &touched)), ["top", "topc", "method"]);
    }

    #[test]
    fn the_innermost_symbol_wins() {
        let outline = [
            sym("Class", 5, 1, 20, None),
            sym("method", 6, 3, 10, Some("Class")),
            sym("other", 6, 12, 15, Some("Class")),
        ];
        let touched = BTreeSet::from([5]);
        assert_eq!(names(&changed_symbols(&outline, &touched)), ["method"]);
    }

    #[test]
    fn equal_spans_prefer_the_later_start() {
        let outline = [sym("outer", 12, 1, 5, None), sym("inner", 12, 2, 6, None)];
        let touched = BTreeSet::from([3]);
        assert_eq!(names(&changed_symbols(&outline, &touched)), ["inner"]);
    }

    #[test]
    fn a_symbol_with_several_touched_lines_is_reported_once_in_outline_order() {
        let outline = [sym("a", 12, 1, 5, None), sym("b", 12, 10, 12, None)];
        let touched = BTreeSet::from([2, 4, 11, 30]);
        assert_eq!(names(&changed_symbols(&outline, &touched)), ["a", "b"]);
    }

    #[test]
    fn file_level_lines_make_no_symbol() {
        let outline = [sym("a", 12, 5, 8, None)];
        assert!(changed_symbols(&outline, &BTreeSet::from([1, 9])).is_empty());
    }

    #[test]
    fn a_line_inside_only_a_disallowed_symbol_falls_to_the_enclosing_allowed_one() {
        let outline = [sym("Class", 5, 1, 20, None), sym("field", 8, 4, 4, Some("Class"))];
        assert_eq!(names(&changed_symbols(&outline, &BTreeSet::from([4]))), ["Class"]);
    }

    /// The scan the sweep replaced: every graphable symbol containing the line, the tightest wins.
    fn scanned(outline: &[LspSymbol], line: u32) -> Option<usize> {
        let line = i64::from(line);
        outline
            .iter()
            .enumerate()
            .filter(|(_, s)| is_graphable(s) && s.line <= line && line <= s.end_line)
            .min_by_key(|(_, s)| (s.end_line - s.line, std::cmp::Reverse(s.line)))
            .map(|(i, _)| i)
    }

    #[test]
    fn a_symbol_holds_its_first_and_last_line_and_not_the_ones_around_it() {
        let outline = [sym("f", 12, 3, 5, None)];
        let spans = Spans::new(&outline);
        let held: Vec<Option<usize>> = (1..=7).map(|l| spans.at(l)).collect();
        assert_eq!(held, [None, None, Some(0), Some(0), Some(0), None, None]);
    }

    #[test]
    fn the_sweep_agrees_with_the_scan_on_random_outlines() {
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut next = move |below: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % below
        };
        let kinds = [2, 5, 6, 12, 13, 14, 8, 22, 26];
        for round in 0..300 {
            let count = next(12) as usize;
            let outline: Vec<LspSymbol> = (0..count)
                .map(|i| {
                    let start = 1 + next(40) as i64;
                    let end = start + next(15) as i64 - if next(9) == 0 { 3 } else { 0 };
                    let container = (next(3) == 0).then_some("c");
                    sym(&format!("s{i}"), kinds[next(kinds.len() as u64) as usize], start, end, container)
                })
                .collect();
            let spans = Spans::new(&outline);
            for line in 0..60 {
                assert_eq!(spans.at(line), scanned(&outline, line), "round {round}, line {line}, outline {outline:?}");
            }
        }
    }

    #[test]
    fn a_multi_file_patch_splits_by_the_path_each_block_names() {
        let patch = concat!(
            "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,2 @@\n x\n+y\n",
            "diff --git a/old.py b/new dir/new.py\nsimilarity index 90%\nrename from old.py\nrename to new dir/new.py\n",
            "--- a/old.py\n+++ b/new dir/new.py\t\n@@ -5,1 +5,1 @@\n-p\n+q\n",
            "diff --git a/mode.py b/mode.py\nold mode 100644\nnew mode 100755\n",
            "diff --git a/gone.py b/gone.py\ndeleted file mode 100644\n--- a/gone.py\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-z\n",
            "diff --git a/n.py b/n.py\nnew file mode 100644\n--- /dev/null\n+++ b/n.py\n@@ -0,0 +1,2 @@\n+a\n+b\n",
        );
        let by_file = edits_by_file(patch);
        let mut got: Vec<(String, Vec<u32>)> =
            by_file.into_iter().map(|(p, e)| (p, unmoved(&[&e]).remove(0).into_iter().collect())).collect();
        got.sort();
        let want = [
            ("a.py", vec![2]),
            ("gone.py", vec![0]),
            ("mode.py", vec![]),
            ("n.py", vec![1, 2]),
            ("new dir/new.py", vec![5]),
        ];
        assert_eq!(got, want.map(|(p, l)| (p.to_owned(), l)));
    }

    #[test]
    fn a_quoted_path_is_left_for_the_caller_to_ask_alone() {
        let patch = "diff --git \"a/q\\\"x.py\" \"b/q\\\"x.py\"\n--- \"a/q\\\"x.py\"\n+++ \"b/q\\\"x.py\"\n@@ -1,1 +1,2 @@\n a\n+b\n";
        assert!(edits_by_file(patch).is_empty());
        assert!(edits_by_file("").is_empty());
    }

    #[test]
    fn a_decorator_only_change_lands_in_no_symbol() {
        // `@cache` sits on line 1; the function's name line is 2.
        let outline = [sym("f", 12, 2, 4, None)];
        assert!(changed_symbols(&outline, &BTreeSet::from([1])).is_empty());
    }
}
