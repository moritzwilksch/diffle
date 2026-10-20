//! Quoting line ranges, following quoted text as a file changes, and review order.
use std::cmp::Ordering;

use crate::protocol::{CommentAnchor, CommentThread};

fn split_lines(contents: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = contents.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Text of [start, end] (1-based, inclusive) joined with '\n'; lines past either end are dropped.
pub fn quote_lines(contents: &str, start: i64, end: i64) -> String {
    let lines = split_lines(contents);
    let from = (start - 1).max(0) as usize;
    let to = (end.max(0) as usize).min(lines.len());
    if from >= to { String::new() } else { lines[from..to].join("\n") }
}

/// Where `quoted` sits in `contents`, the match nearest `start` preferred: the moved range, or
/// none when the text is gone. An empty quote stays where it is.
pub fn relocate(start: i64, end: i64, quoted: &str, contents: &str) -> Option<(i64, i64)> {
    let lines = split_lines(contents);
    let quoted = split_lines(quoted);
    if quoted.is_empty() {
        return Some((start, end));
    }
    let span = quoted.len();
    let mut best: Option<(i64, i64)> = None;
    for i in 0..(lines.len() + 1).saturating_sub(span) {
        if lines[i..i + span] != quoted[..] {
            continue;
        }
        let at = i as i64 + 1;
        let dist = (at - start).abs();
        if best.is_none_or(|(_, d)| dist < d) {
            best = Some((at, dist));
            if dist == 0 {
                break;
            }
        }
    }
    best.map(|(at, _)| (at, at + span as i64 - 1))
}

/// Text of a 1-based inclusive range, or none when the range does not fit the contents: the
/// server refuses to quote lines that do not exist.
pub fn quote_range(contents: &str, start: i64, end: i64) -> Option<String> {
    let lines = split_lines(contents);
    if start < 1 || end < start || end > lines.len() as i64 {
        return None;
    }
    Some(lines[start as usize - 1..end as usize].join("\n"))
}

pub fn anchor_path(anchor: &CommentAnchor) -> &str {
    match anchor {
        CommentAnchor::Line { path, .. } | CommentAnchor::File { path } => path,
    }
}

/// The line a thread sorts under: a file thread comes before every line of its file.
pub fn anchor_line(anchor: &CommentAnchor) -> i64 {
    match anchor {
        CommentAnchor::Line { start_line, .. } => *start_line,
        CommentAnchor::File { .. } => 0,
    }
}

/// Review order: by path, then line (file threads first), then when the thread was opened.
pub fn compare_threads(a: &CommentThread, b: &CommentThread) -> Ordering {
    let opened = |t: &CommentThread| t.messages.first().map_or(0, |m| m.created_at);
    anchor_path(&a.anchor)
        .cmp(anchor_path(&b.anchor))
        .then(anchor_line(&a.anchor).cmp(&anchor_line(&b.anchor)))
        .then(opened(a).cmp(&opened(b)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CommentMessage, Side};

    fn line(path: &str, start: i64) -> CommentAnchor {
        CommentAnchor::Line {
            path: path.into(),
            side: Side::New,
            start_line: start,
            end_line: start,
            quoted: "x".into(),
        }
    }

    fn thread(id: &str, anchor: CommentAnchor, created_at: i64) -> CommentThread {
        let message = CommentMessage { id: format!("{id}-m"), body: "b".into(), created_at, updated_at: created_at };
        CommentThread {
            id: id.into(),
            anchor,
            messages: vec![message],
            resolved: false,
            resolved_at: None,
            stale: false,
            stale_from_line: None,
        }
    }

    #[test]
    fn quotes_an_inclusive_one_based_range() {
        assert_eq!(quote_lines("a\nb\nc\nd\n", 2, 3), "b\nc");
        assert_eq!(quote_range("a\nb\n", 2, 2).as_deref(), Some("b"));
        assert_eq!(quote_range("a\nb\n", 2, 3), None);
        assert_eq!(quote_range("a\nb\n", 0, 1), None);
    }

    #[test]
    fn relocates_quoted_text() {
        // Unmoved text stays; shifted text is followed.
        assert_eq!(relocate(2, 2, "b", "a\nb\nc\n"), Some((2, 2)));
        assert_eq!(relocate(2, 3, "b\nc", "x\ny\na\nb\nc\n"), Some((4, 5)));
        // The match nearest the original line wins.
        let contents = "x\nx\nx\nx\nx\nx\nx\nx\n";
        assert_eq!(relocate(6, 6, "x", contents), Some((6, 6)));
        assert_eq!(relocate(20, 20, "x", contents), Some((8, 8)));
        // Gone, or not contiguous.
        assert_eq!(relocate(1, 1, "gone", "a\nb\n"), None);
        assert_eq!(relocate(1, 2, "a\nc", "a\nb\nc\n"), None);
    }

    #[test]
    fn orders_by_path_then_line_with_the_file_thread_first_then_creation() {
        let mut threads = [
            thread("z", line("z.py", 1), 1),
            thread("later-file", CommentAnchor::File { path: "a.py".into() }, 5),
            thread("line", line("a.py", 3), 1),
            thread("file", CommentAnchor::File { path: "a.py".into() }, 2),
            thread("other", CommentAnchor::File { path: "b.py".into() }, 1),
        ];
        threads.sort_by(compare_threads);
        let ids: Vec<&str> = threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["file", "later-file", "line", "other", "z"]);
    }
}
