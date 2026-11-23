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

/// Text of a 1-based inclusive range, or none when the range does not fit the contents: the
/// server refuses to quote lines that do not exist.
pub fn quote_range(contents: &str, start: i64, end: i64) -> Option<String> {
    let lines = split_lines(contents);
    if start < 1 || end < start || end > lines.len() as i64 {
        return None;
    }
    Some(lines[start as usize - 1..end as usize].join("\n"))
}

/// The file a thread is on; none for a thread on the tour.
pub fn anchor_path(anchor: &CommentAnchor) -> Option<&str> {
    match anchor {
        CommentAnchor::Line { path, .. } | CommentAnchor::File { path } => Some(path),
        CommentAnchor::Tour { .. } => None,
    }
}

/// Where a thread sorts: code by path, then line (a file thread before every line of its file);
/// after all code, the tour in document order.
fn place(anchor: &CommentAnchor) -> (Option<&str>, i64, &[i64]) {
    match anchor {
        CommentAnchor::Line { path, start_line, .. } => (Some(path), *start_line, &[]),
        CommentAnchor::File { path } => (Some(path), 0, &[]),
        CommentAnchor::Tour { node, .. } => (None, 0, node),
    }
}

/// Review order: code threads by path and line, then tour threads in document order, then when
/// each thread was opened.
pub fn compare_threads(a: &CommentThread, b: &CommentThread) -> Ordering {
    let opened = |t: &CommentThread| t.messages.first().map_or(0, |m| m.created_at);
    let (a_path, a_line, a_node) = place(&a.anchor);
    let (b_path, b_line, b_node) = place(&b.anchor);
    // `None` sorts first: put the tour's threads last.
    (a_path.is_none(), a_path, a_line, a_node)
        .cmp(&(b_path.is_none(), b_path, b_line, b_node))
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
        let message = CommentMessage {
            id: format!("{id}-m"),
            body: "b".into(),
            created_at,
            updated_at: created_at,
            author: None,
        };
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
