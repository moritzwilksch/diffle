//! Moved code is not changed code. A symbol whose lines only changed place (an enum and its impl
//! carried to another file) must not read as new code, or everything that mentions it looks like a
//! caller of a brand-new symbol.
//!
//! Modelled on `git diff --color-moved`: a run of added lines is moved when the same lines, trimmed of
//! surrounding whitespace, form a run of removed lines somewhere in the same diff, and the match holds
//! enough alphanumeric text that a lone `}` never counts. The removed side is dropped alike, so the
//! hole a block left behind does not mark its neighbour. Only fingerprints are kept, never the text.
use std::collections::{BTreeSet, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};

/// Alphanumeric characters a matching run needs to be a move: git's own threshold.
const MIN_ALNUM: u64 = 20;
/// A line repeated more often than this among the removed lines anchors no match: it says nothing
/// about where a block came from, and its pairs would grow with the square of the repeats.
const MAX_ANCHORS: usize = 64;

/// A line as matching sees it: its trimmed text hashed, and how much of it is alphanumeric.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Print {
    hash: u64,
    alnum: u32,
}

/// Stands between two runs so a match never spans them. No line hashes to it.
const BREAK: Print = Print { hash: 0, alnum: 0 };

impl Print {
    pub fn of(line: &str) -> Self {
        let text = line.trim();
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        let alnum = text.chars().filter(|c| c.is_alphanumeric()).count();
        Self { hash: hasher.finish().max(1), alnum: u32::try_from(alnum).unwrap_or(u32::MAX) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Added,
    Removed,
}

/// Consecutive added or removed lines of one hunk. `first` is the new-side line of the first added
/// line; for removed lines, the new-side line now at their position, shared by all of them.
#[derive(Clone, Debug)]
pub struct Run {
    pub side: Side,
    pub first: u32,
    pub prints: Vec<Print>,
}

/// One file's edits, as runs of line fingerprints in patch order.
#[derive(Clone, Debug, Default)]
pub struct Edits {
    runs: Vec<Run>,
}

impl Edits {
    pub fn push(&mut self, run: Run) {
        self.runs.push(run);
    }

    pub fn runs(&self) -> &[Run] {
        &self.runs
    }
}

/// The lines each of `files` still changes once moved code is set aside, in the order given. A file
/// whose edits all moved ends up with none.
pub fn unmoved(files: &[&Edits]) -> Vec<BTreeSet<u32>> {
    let strip = |side| Strip::of(files.iter().flat_map(|e| &e.runs).filter(|r| r.side == side));
    let (mut added, mut removed) = (strip(Side::Added), strip(Side::Removed));
    find_moves(&mut added, &mut removed);
    added.take_along_the_edges();
    removed.take_along_the_edges();
    let (mut next_added, mut next_removed) = (0, 0);
    files
        .iter()
        .map(|edits| {
            let mut left = BTreeSet::new();
            for run in &edits.runs {
                let (strip, cursor) = match run.side {
                    Side::Added => (&added, &mut next_added),
                    Side::Removed => (&removed, &mut next_removed),
                };
                let moved = &strip.moved[*cursor..*cursor + run.prints.len()];
                match run.side {
                    Side::Added => left.extend(
                        (0..).zip(moved).filter(|(_, moved)| !**moved).map(|(k, _)| run.first.saturating_add(k)),
                    ),
                    Side::Removed => {
                        if moved.iter().any(|moved| !moved) {
                            left.insert(run.first);
                        }
                    }
                }
                *cursor += run.prints.len() + 1;
            }
            left
        })
        .collect()
}

/// One side's runs end to end, a `BREAK` after each, and which of their lines turned out moved.
struct Strip {
    prints: Vec<Print>,
    moved: Vec<bool>,
}

impl Strip {
    fn of<'a>(runs: impl Iterator<Item = &'a Run>) -> Self {
        let prints: Vec<Print> = runs.flat_map(|run| run.prints.iter().copied().chain([BREAK])).collect();
        Self { moved: vec![false; prints.len()], prints }
    }

    /// Blank and brace-only lines next to a moved block go with it: they say nothing of their own,
    /// and which of them git put on the block's side of the edge is arbitrary.
    fn take_along_the_edges(&mut self) {
        let mut near = false;
        for at in 0..self.prints.len() {
            near = self.take_along(at, near);
        }
        near = false;
        for at in (0..self.prints.len()).rev() {
            near = self.take_along(at, near);
        }
    }

    /// Whether the line at `at` is moved, given whether its neighbour on the way here was.
    fn take_along(&mut self, at: usize, near_moved: bool) -> bool {
        if self.prints[at] == BREAK {
            return false;
        }
        if near_moved && self.prints[at].alnum == 0 {
            self.moved[at] = true;
        }
        self.moved[at]
    }
}

fn same(a: Print, b: Print) -> bool {
    a == b && a != BREAK
}

/// The removed positions of each line that carries text, unless it is too common to anchor anything.
fn anchors(removed: &[Print]) -> HashMap<u64, Vec<usize>> {
    let mut at: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, print) in removed.iter().enumerate().filter(|(_, p)| p.alnum > 0) {
        let seen = at.entry(print.hash).or_default();
        if seen.len() <= MAX_ANCHORS {
            seen.push(i);
        }
    }
    at.retain(|_, seen| seen.len() <= MAX_ANCHORS);
    at
}

/// Marks every maximal common stretch of the two sides that holds enough text. A stretch is found
/// from its first line that carries text: each such line is tried against the removed lines equal to
/// it, and a diagonal already walked is skipped, so the work stays near the number of equal pairs.
fn find_moves(added: &mut Strip, removed: &mut Strip) {
    let anchors = anchors(&removed.prints);
    let (ap, rp) = (&added.prints, &removed.prints);
    let mut walked: HashMap<usize, usize> = HashMap::new();
    for (i, print) in ap.iter().enumerate().filter(|(_, p)| p.alnum > 0) {
        for &r in anchors.get(&print.hash).into_iter().flatten() {
            let diagonal = i.wrapping_sub(r);
            if walked.get(&diagonal).is_some_and(|&end| end > i) {
                continue;
            }
            let (mut from_a, mut from_r) = (i, r);
            while from_a > 0 && from_r > 0 && same(ap[from_a - 1], rp[from_r - 1]) {
                (from_a, from_r) = (from_a - 1, from_r - 1);
            }
            let (mut to_a, mut to_r) = (i + 1, r + 1);
            while to_a < ap.len() && to_r < rp.len() && same(ap[to_a], rp[to_r]) {
                (to_a, to_r) = (to_a + 1, to_r + 1);
            }
            walked.insert(diagonal, to_a);
            let alnum: u64 = ap[from_a..to_a].iter().map(|p| u64::from(p.alnum)).sum();
            if alnum >= MIN_ALNUM {
                added.moved[from_a..to_a].fill(true);
                removed.moved[from_r..to_r].fill(true);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    /// A line that carries 27 alphanumeric characters by itself, so it is a move alone.
    fn line(n: usize) -> String {
        format!("    let value_{n} = compute_total(items, {n});")
    }

    fn lines(range: std::ops::Range<usize>) -> Vec<String> {
        range.map(line).collect()
    }

    fn run(side: Side, first: u32, text: &[String]) -> Run {
        Run { side, first, prints: text.iter().map(|l| Print::of(l)).collect() }
    }

    fn edits(runs: Vec<Run>) -> Edits {
        Edits { runs }
    }

    fn left(files: &[&Edits]) -> Vec<Vec<u32>> {
        unmoved(files).into_iter().map(|set| set.into_iter().collect()).collect()
    }

    #[test]
    fn a_block_removed_here_and_added_verbatim_there_changes_nothing() {
        let from = edits(vec![run(Side::Removed, 5, &lines(0..3))]);
        let to = edits(vec![run(Side::Added, 10, &lines(0..3))]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![]]);
    }

    #[test]
    fn a_move_inside_one_file_is_no_change_either() {
        let file = edits(vec![run(Side::Removed, 3, &lines(0..4)), run(Side::Added, 40, &lines(0..4))]);
        assert_eq!(left(&[&file]), [Vec::<u32>::new()]);
    }

    #[test]
    fn surrounding_whitespace_does_not_tell_lines_apart() {
        let indented: Vec<String> = lines(0..3).iter().map(|l| format!("\t  {l}  ")).collect();
        let from = edits(vec![run(Side::Removed, 1, &lines(0..3))]);
        let to = edits(vec![run(Side::Added, 1, &indented)]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![]]);
    }

    #[test]
    fn a_match_needs_twenty_alphanumeric_characters_in_all() {
        let table = [("abcdefghijklmnopqrs", true), ("abcdefghijklmnopqrst", false)];
        for (text, stays) in table {
            let from = edits(vec![run(Side::Removed, 1, &[text.into()])]);
            let to = edits(vec![run(Side::Added, 7, &[text.into()])]);
            let want = if stays { vec![vec![1], vec![7]] } else { vec![vec![], vec![]] };
            assert_eq!(left(&[&from, &to]), want, "{text}");
        }
    }

    #[test]
    fn a_match_is_counted_over_all_its_lines_not_one_by_one() {
        let short = ["let aaa = bbb;".to_owned(), "let ccc = ddd;".into(), "let eee = fff;".into()];
        let from = edits(vec![run(Side::Removed, 1, &short)]);
        let to = edits(vec![run(Side::Added, 7, &short)]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![]]);
    }

    #[test]
    fn braces_and_blanks_alone_are_never_a_move() {
        let closers = ["}".to_owned(), String::new(), ")".into(), "});".into(), "use x;".into()];
        let from = edits(vec![run(Side::Removed, 1, &closers)]);
        let to = edits(vec![run(Side::Added, 7, &closers)]);
        assert_eq!(left(&[&from, &to]), [vec![1], vec![7, 8, 9, 10, 11]]);
    }

    #[test]
    fn only_the_matching_part_of_a_run_moves() {
        let mut added = lines(0..2);
        added.push("    let fresh = brand_new_code(1);".into());
        let from = edits(vec![run(Side::Removed, 4, &lines(0..2))]);
        let to = edits(vec![run(Side::Added, 10, &added)]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![12]]);
    }

    #[test]
    fn a_moved_block_that_was_edited_keeps_its_edited_line_as_changed() {
        let mut edited = lines(0..5);
        edited[2] = "    let value_2 = compute_total(items, 99);".into();
        let from = edits(vec![run(Side::Removed, 4, &lines(0..5))]);
        let to = edits(vec![run(Side::Added, 10, &edited)]);
        // The edited line stays at the destination; its original, gone from the source, still marks the hole.
        assert_eq!(left(&[&from, &to]), [vec![4], vec![12]]);
    }

    #[test]
    fn a_block_copied_twice_moves_both_times() {
        let from = edits(vec![run(Side::Removed, 1, &lines(0..2))]);
        let to = edits(vec![run(Side::Added, 10, &lines(0..2)), run(Side::Added, 30, &lines(0..2))]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![]]);
    }

    #[test]
    fn a_block_only_added_or_only_removed_is_a_change() {
        let from = edits(vec![run(Side::Removed, 1, &lines(0..2))]);
        let to = edits(vec![run(Side::Added, 10, &lines(5..7))]);
        assert_eq!(left(&[&from, &to]), [vec![1], vec![10, 11]]);
    }

    #[test]
    fn blank_and_brace_lines_at_a_moved_blocks_edges_go_with_it() {
        let mut leaving = vec![String::new()];
        leaving.extend(lines(0..2));
        leaving.extend(["}".to_owned(), String::new()]);
        let from = edits(vec![run(Side::Removed, 4, &leaving)]);
        let to = edits(vec![run(Side::Added, 10, &lines(0..2))]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![]]);
    }

    #[test]
    fn a_blank_between_a_move_and_other_text_does_not_carry_the_other_text() {
        let mut added = lines(0..2);
        added.extend([String::new(), "    let fresh = brand_new_code(1);".into()]);
        let from = edits(vec![run(Side::Removed, 4, &lines(0..2))]);
        let to = edits(vec![run(Side::Added, 10, &added)]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![13]]);
    }

    #[test]
    fn a_run_does_not_match_across_the_gap_between_two_runs() {
        // Removed [a, b] then [c]: an added [a, b, c] has only [a, b] and [c] to match.
        let mut all = lines(0..3);
        let tail = all.split_off(2);
        let from = edits(vec![run(Side::Removed, 1, &all), run(Side::Removed, 9, &tail)]);
        let to = edits(vec![run(Side::Added, 20, &lines(0..3))]);
        assert_eq!(left(&[&from, &to]), [Vec::<u32>::new(), vec![]]);
        // ...yet a longer sequence than the removed runs hold stays a change.
        let long = edits(vec![run(Side::Added, 20, &lines(0..3)), run(Side::Added, 40, &lines(7..9))]);
        assert_eq!(left(&[&from, &long]), [Vec::<u32>::new(), vec![40, 41]]);
    }

    #[test]
    fn the_print_ignores_surrounding_whitespace_and_counts_alphanumerics() {
        assert_eq!(Print::of("  foo(1);\t"), Print::of("foo(1);"));
        assert_ne!(Print::of("foo(1);"), Print::of("foo(2);"));
        assert_eq!((Print::of("a_b-c é9 ;").alnum, Print::of("  }  ").alnum, Print::of("").alnum), (5, 0, 0));
    }

    #[test]
    fn a_large_diff_is_matched_in_a_moment() {
        // 200 files lose 100 lines each, 200 others gain them: 20k lines on each side.
        let (sources, targets): (Vec<Edits>, Vec<Edits>) = (0..200)
            .map(|f| {
                let text = lines(f * 100..f * 100 + 100);
                let at = u32::try_from(f).unwrap();
                (edits(vec![run(Side::Removed, at, &text)]), edits(vec![run(Side::Added, at, &text)]))
            })
            .unzip();
        let all: Vec<&Edits> = sources.iter().chain(&targets).collect();
        let started = Instant::now();
        let got = unmoved(&all);
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        assert!(got.iter().all(BTreeSet::is_empty), "{:?}", got.iter().map(BTreeSet::len).sum::<usize>());
    }

    #[test]
    fn a_line_anchors_a_match_up_to_the_cap_and_not_past_it() {
        let table = [(MAX_ANCHORS, true), (MAX_ANCHORS + 1, false)];
        for (copies, moves) in table {
            let from: Vec<Edits> =
                (0..copies).map(|n| edits(vec![run(Side::Removed, n as u32, &lines(0..1))])).collect();
            let to = edits(vec![run(Side::Added, 1, &lines(0..1))]);
            let all: Vec<&Edits> = from.iter().chain([&to]).collect();
            let added = unmoved(&all).pop().unwrap();
            assert_eq!(added.is_empty(), moves, "{copies} copies");
        }
    }

    #[test]
    fn a_line_repeated_thousands_of_times_is_bounded_work_and_anchors_nothing() {
        let same = vec![line(1); 20_000];
        let from = edits(vec![run(Side::Removed, 1, &same)]);
        let to = edits(vec![run(Side::Added, 1, &same)]);
        let started = Instant::now();
        let got = unmoved(&[&from, &to]);
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
        assert_eq!((got[0].len(), got[1].len()), (1, 20_000));
    }
}
