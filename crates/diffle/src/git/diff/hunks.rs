//! Line diffs grouped into hunks as git groups them, each with the function line its `@@` header names.
use gix::diff::blob::unified_diff::{ConsumeHunk, ContextSize, DiffLineKind, HunkHeader};
use gix::diff::blob::{Algorithm, Diff, InternedInput, UnifiedDiff};

/// Git keeps this much of a hunk's function line.
const FUNC_LINE: usize = 80;

/// One hunk: its `@@ -a,b +c,d @@` range, function line, and prefixed lines (` `, `-`, `+`), each
/// with its newline unless it is a side's unterminated last line.
pub struct Hunk {
    pub header: String,
    pub func: Vec<u8>,
    pub lines: Lines,
}

/// A hunk's lines, each with its prefix.
pub type Lines = Vec<(u8, Vec<u8>)>;

/// The line diff git computes: Myers, with git's slider compaction, and its indent heuristic when
/// `indent` (as `git diff` has it on; range-diff's internal comparison runs without).
fn line_diff<'a>(old: &'a [u8], new: &'a [u8], indent: bool) -> (InternedInput<&'a [u8]>, Diff) {
    let input = InternedInput::new(old, new);
    let diff = if indent {
        gix::diff::blob::diff_with_slider_heuristics(Algorithm::Myers, &input)
    } else {
        let mut diff = Diff::compute(Algorithm::Myers, &input);
        diff.postprocess_no_heuristic(&input);
        diff
    };
    (input, diff)
}

/// Lines added and removed, as `--numstat` counts them.
pub fn line_counts(old: &[u8], new: &[u8]) -> (i64, i64) {
    let (_, diff) = line_diff(old, new, true);
    (i64::from(diff.count_additions()), i64::from(diff.count_removals()))
}

/// The hunks of a text diff with `context` lines around each change; changes at most twice the
/// context apart share a hunk.
pub fn hunks(old: &[u8], new: &[u8], context: u32, indent: bool) -> Vec<Hunk> {
    let (input, diff) = line_diff(old, new, indent);
    let Ok(grouped) = UnifiedDiff::new(&diff, &input, Collect::default(), ContextSize::symmetrical(context)).consume()
    else {
        unreachable!("collecting hunks cannot fail")
    };
    let mut func = FuncLine::default();
    grouped
        .0
        .into_iter()
        .map(|(h, lines)| {
            // Git names an empty side's range by the line before it, not one past it.
            let range = |start: u32, count: u32| {
                let start = if count == 0 { start - 1 } else { start };
                if count == 1 { format!("{start}") } else { format!("{start},{count}") }
            };
            let header = format!(
                "@@ -{} +{} @@",
                range(h.before_hunk_start, h.before_hunk_len),
                range(h.after_hunk_start, h.after_hunk_len)
            );
            let func = func.find(|l| input.interner[input.before[l as usize]], i64::from(h.before_hunk_start) - 2);
            Hunk { header, func: func.to_vec(), lines }
        })
        .collect()
}

/// Each hunk's range and its lines, prefixed as a patch prints them.
#[derive(Default)]
struct Collect(Vec<(HunkHeader, Lines)>);

impl ConsumeHunk for Collect {
    type Out = Self;

    fn consume_hunk(&mut self, header: HunkHeader, lines: &[(DiffLineKind, &[u8])]) -> std::io::Result<()> {
        let prefixed = lines.iter().map(|&(kind, line)| (kind.to_prefix() as u8, line.to_vec())).collect();
        self.0.push((header, prefixed));
        Ok(())
    }

    fn finish(self) -> Self {
        self
    }
}

/// The `@@` header's function line: the nearest old-side line above the hunk that starts with a
/// letter, `_` or `$`, searched back only to the previous hunk's start and otherwise carried over.
#[derive(Default)]
struct FuncLine {
    text: Vec<u8>,
    searched_to: Option<i64>,
}

impl FuncLine {
    fn find<'a>(&'a mut self, line: impl Fn(u32) -> &'a [u8], start: i64) -> &'a [u8] {
        let limit = self.searched_to.unwrap_or(-1);
        self.searched_to = Some(start);
        let mut l = start;
        while l > limit && l >= 0 {
            let rec = line(l as u32);
            if rec.first().is_some_and(|&c| c.is_ascii_alphabetic() || c == b'_' || c == b'$') {
                let mut len = rec.len().min(FUNC_LINE);
                while len > 0 && is_space(rec[len - 1]) {
                    len -= 1;
                }
                // Whitespace goes first: a space before the split character stays.
                if len < rec.len() {
                    len = whole_chars(&rec[..len]);
                }
                self.text = rec[..len].to_vec();
                break;
            }
            l -= 1;
        }
        &self.text
    }
}

/// How much of `cut` ends on a whole UTF-8 character: git drops a sequence the cut split.
fn whole_chars(cut: &[u8]) -> usize {
    let start = cut.len().saturating_sub(4);
    let Some(lead) = (start..cut.len()).rev().find(|&i| cut[i] & 0xc0 != 0x80) else { return cut.len() };
    let width = match cut[lead] {
        b if b >= 0xf0 => 4,
        b if b >= 0xe0 => 3,
        b if b >= 0xc0 => 2,
        _ => 1,
    };
    if lead + width > cut.len() { lead } else { cut.len() }
}

/// C's `isspace`, which git trims the function line with.
fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}
