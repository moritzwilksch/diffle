//! Code a diff moved rather than changed. Like `git diff --color-moved`, a block counts as moved
//! when its lines, whitespace aside, were removed in one place and added in another, in this file
//! or another. A moved symbol is not a change to graph, and without this a moved type reads as an
//! added hub.
use std::collections::HashSet;

use crate::comments::hunks::NewSideChanges;

/// Consecutive non-blank lines that must match before code counts as moved: shorter runs, such as
/// a lone `}` or `return None`, match by chance.
const WINDOW: usize = 3;

/// What the whole diff removed and added, as windows of lines.
pub struct Moves {
    removed: HashSet<String>,
    added: HashSet<String>,
}

impl Moves {
    /// Reads every file of the diff, `diff` being all their patches parsed as one: code may move
    /// out of a deleted file, or into one no language server reads.
    pub fn of(diff: &NewSideChanges) -> Self {
        let removed = diff.removed_runs.iter().flat_map(|run| windows(run.iter().map(String::as_str))).collect();
        let added = diff.added_runs.iter().flat_map(|run| windows(run.iter().map(|(_, t)| t.as_str()))).collect();
        Self { removed, added }
    }

    /// Drops from one file's changes the added lines that were removed elsewhere, and the removals
    /// that were wholly added back elsewhere.
    pub fn drop_from(&self, file: &mut NewSideChanges) {
        let mut ranges: Vec<(i64, i64)> = Vec::new();
        for run in &file.added_runs {
            let moved = matched(run.iter().map(|(_, text)| text.as_str()), &self.removed);
            for ((line, _), moved) in run.iter().zip(moved) {
                if moved {
                    continue;
                }
                match ranges.last_mut() {
                    Some((_, end)) if *end == line - 1 => *end = *line,
                    _ => ranges.push((*line, *line)),
                }
            }
        }
        file.added = ranges;
        let kept: Vec<bool> = file
            .removed_runs
            .iter()
            .map(|run| !matched(run.iter().map(String::as_str), &self.added).into_iter().all(|moved| moved))
            .collect();
        let mut keep = kept.iter();
        file.removed_at.retain(|_| *keep.next().unwrap());
        let mut keep = kept.iter();
        file.removed_runs.retain(|_| *keep.next().unwrap());
    }
}

/// Every `WINDOW` consecutive non-blank lines of a run, whitespace-trimmed and joined.
fn windows<'a>(run: impl Iterator<Item = &'a str>) -> Vec<String> {
    let lines: Vec<&str> = run.map(str::trim).filter(|l| !l.is_empty()).collect();
    lines.windows(WINDOW).map(|w| w.join("\n")).collect()
}

/// Per line of a run, whether a window of it lies in `elsewhere`. A blank line is moved when the
/// lines around it are: it belongs to the block, not to a change.
fn matched<'a>(run: impl Iterator<Item = &'a str>, elsewhere: &HashSet<String>) -> Vec<bool> {
    let lines: Vec<&str> = run.map(str::trim).collect();
    let solid: Vec<usize> = (0..lines.len()).filter(|&i| !lines[i].is_empty()).collect();
    let mut moved = vec![false; lines.len()];
    for w in solid.windows(WINDOW) {
        let key = w.iter().map(|&i| lines[i]).collect::<Vec<_>>().join("\n");
        if elsewhere.contains(&key) {
            w.iter().for_each(|&i| moved[i] = true);
        }
    }
    for i in 0..lines.len() {
        if lines[i].is_empty() {
            let before = (0..i).rev().find(|&j| !lines[j].is_empty());
            let after = (i + 1..lines.len()).find(|&j| !lines[j].is_empty());
            moved[i] = matches!((before, after), (Some(b), Some(a)) if moved[b] && moved[a]);
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comments::hunks::new_side_changes;

    const FN: [&str; 4] = ["def total(rows):", "    s = 0", "    for r in rows:", "        s += r"];

    fn patch(old: u32, new: u32, lines: &[String]) -> String {
        let (minus, plus) =
            (lines.iter().filter(|l| l.starts_with('-')).count(), lines.iter().filter(|l| l.starts_with('+')).count());
        format!("@@ -{old},{minus} +{new},{plus} @@\n{}\n", lines.join("\n"))
    }

    #[test]
    fn a_function_moved_to_another_file_and_reindented_is_no_change() {
        let removed: Vec<String> = FN.iter().map(|l| format!("-{l}")).collect();
        let added: Vec<String> = FN.iter().map(|l| format!("+    {l}")).collect();
        let (a, b) = (patch(10, 9, &removed), patch(3, 4, &added));
        let moves = Moves::of(&new_side_changes(&format!("{a}{b}")));
        let mut files = [new_side_changes(&a), new_side_changes(&b)];
        files.iter_mut().for_each(|f| moves.drop_from(f));
        assert!(files.iter().all(|f| f.added.is_empty() && f.removed_at.is_empty()), "{files:?}");
    }

    #[test]
    fn an_edit_inside_moved_code_stays_a_change_and_short_runs_never_count_as_moved() {
        let removed: Vec<String> = FN.iter().map(|l| format!("-{l}")).chain(["-return".to_owned()]).collect();
        let mut added: Vec<String> = FN.iter().map(|l| format!("+{l}")).collect();
        added.push("+        s += 1".to_owned());
        added.push("+return".to_owned());
        let (a, b) = (patch(1, 1, &removed), patch(1, 1, &added));
        let moves = Moves::of(&new_side_changes(&format!("{a}{b}")));
        let mut files = [new_side_changes(&a), new_side_changes(&b)];
        files.iter_mut().for_each(|f| moves.drop_from(f));
        // Lines 1-4 moved; line 5 is new, and the lone `return` matches by chance only.
        assert_eq!(files[1].added, [(5, 6)]);
        // The removed run held the `return` too, which nothing re-added as a block: it stays.
        assert_eq!(files[0].removed_at, [1]);
    }
}
