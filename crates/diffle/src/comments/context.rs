//! Capturing evidence at review time and locating it in a later version of the file.
use crate::protocol::{CommentAnchor, FeedbackLocation, ReviewContextLine, ReviewEvidence, Side};

const NEARBY: i64 = 3;
const LINE_BYTES: usize = 250;
const EXCERPT_BYTES: usize = 4000;

fn truncate(text: &str, max: usize) -> (&str, bool) {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], text.len() > max)
}

impl ReviewEvidence {
    pub fn capture(path: &str, side: Side, start: i64, end: i64, quote: &str, contents: &str) -> Self {
        let lines: Vec<_> = contents.lines().collect();
        let nearby = |from: i64, through: i64| {
            (from.max(1)..=through.min(lines.len() as i64))
                .map(|line| {
                    let (text, truncated) = truncate(lines[(line - 1) as usize], LINE_BYTES);
                    ReviewContextLine { line, text: text.into(), truncated }
                })
                .collect()
        };
        let (excerpt, excerpt_truncated) = truncate(quote, EXCERPT_BYTES);
        Self {
            path: path.into(),
            side,
            start_line: start,
            end_line: end,
            excerpt: excerpt.into(),
            excerpt_truncated,
            before: nearby(start.saturating_sub(NEARBY), start - 1),
            after: nearby(end.saturating_add(1), end.saturating_add(NEARBY)),
        }
    }

    pub fn from_anchor(anchor: &CommentAnchor) -> Option<Self> {
        let CommentAnchor::Line { path, side, start_line, end_line, quoted } = anchor else { return None };
        Some(Self::capture(path, *side, *start_line, *end_line, quoted, ""))
    }

    /// Reports a range only for an exact match or an area bracketed by two unique context lines.
    pub fn locate(&self, contents: &str) -> (FeedbackLocation, Option<(i64, i64)>) {
        let lines: Vec<_> = contents.lines().collect();
        let bounds = self.bounds(&lines);
        let wanted: Vec<_> = self.excerpt.split('\n').map(|line| line.trim_end_matches('\r')).collect();
        let has_context = self.before.iter().chain(&self.after).any(usable);
        let mut best = None;
        let mut tied = false;
        if !self.excerpt_truncated {
            for (index, candidate) in lines.windows(wanted.len()).enumerate() {
                if candidate != wanted {
                    continue;
                }
                let start = index as i64 + 1;
                let end = start + wanted.len() as i64 - 1;
                if bounds.is_some_and(|(lo, hi)| start < lo || end > hi) {
                    continue;
                }
                let score = nearby_score(&lines, &self.before, self.start_line, start)
                    + nearby_score(&lines, &self.after, self.end_line, end);
                match best {
                    Some((other, _, _)) if score == other => tied = true,
                    Some((other, _, _)) if score < other => {}
                    _ => {
                        best = Some((score, start, end));
                        tied = false;
                    }
                }
            }
        }
        if tied {
            return (FeedbackLocation::Ambiguous, None);
        }
        if let Some((score, start, end)) = best
            && (score > 0 || !has_context || bounds.is_some())
        {
            let location = if start == self.start_line { FeedbackLocation::Unchanged } else { FeedbackLocation::Moved };
            return (location, Some((start, end)));
        }
        match bounds {
            Some((lo, hi)) if lo > hi => (FeedbackLocation::Deleted, None),
            Some(range) => (FeedbackLocation::Changed, Some(range)),
            None => (FeedbackLocation::Unlocated, None),
        }
    }

    fn bounds(&self, lines: &[&str]) -> Option<(i64, i64)> {
        let above = self.before.iter().rev().filter(|line| usable(line)).find_map(|line| unique(lines, &line.text))?;
        let below = self.after.iter().filter(|line| usable(line)).find_map(|line| unique(lines, &line.text))?;
        (above < below && below - above <= self.end_line - self.start_line + 13).then_some((above + 1, below - 1))
    }
}

fn usable(line: &ReviewContextLine) -> bool {
    !line.truncated && !line.text.trim().is_empty()
}

fn unique(lines: &[&str], text: &str) -> Option<i64> {
    let mut matches = lines.iter().enumerate().filter(|(_, line)| **line == text);
    let (index, _) = matches.next()?;
    matches.next().is_none().then_some(index as i64 + 1)
}

fn nearby_score(lines: &[&str], context: &[ReviewContextLine], original: i64, current: i64) -> usize {
    context
        .iter()
        .filter(|line| {
            usable(line) && lines.get((current + line.line - original - 1) as usize) == Some(&line.text.as_str())
        })
        .count()
}
