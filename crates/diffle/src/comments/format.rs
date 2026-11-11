//! The agent prompt a review exports as.
use std::sync::LazyLock;

use regex::Regex;

use super::anchor::compare_threads;
use crate::protocol::{CommentAnchor, CommentAuthor, CommentMessage, CommentThread, Side, TourTarget};
use crate::tour::spoken;

static SUGGESTION_FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^```suggestion[^\n]*\n([\s\S]*?)\n?^```[ \t]*$").unwrap());

/// Agent-prompt format, one block per thread:
///
///   path:line            (or path:start-end; `(file) path` for a thread on the whole file;
///                         `(tour) 2. Heading, in a <p>` for a selection in the tour, `, on the card
///                         #auth` for a tour element as a whole)
///
///   > quoted line        (absent for a file thread; a tour element's label)
///
///   body                 (a thread's messages joined by a blank line; an agent's starts `(agent) `)
///
///   ---
///
/// A ```suggestion fence in a body expands to ORIGINAL / SUGGESTED fences; a file thread has no
/// original, so its fences stay as written.
pub fn format_prompt(threads: &[CommentThread]) -> String {
    let mut sorted: Vec<&CommentThread> = threads.iter().collect();
    sorted.sort_by(|a, b| compare_threads(a, b));
    sorted.into_iter().map(format_one).collect::<Vec<_>>().join("\n")
}

fn format_one(t: &CommentThread) -> String {
    let (path, side, start, end, quoted) = match &t.anchor {
        CommentAnchor::File { path } => {
            let header = format!("(file) {}{path}", if t.stale { "(stale) " } else { "" });
            let body: Vec<String> = t.messages.iter().map(|m| signed(m, m.body.trim().to_owned())).collect();
            return format!("{header}\n\n{}\n\n---\n", body.join("\n\n"));
        }
        CommentAnchor::Line { path, side, start_line, end_line, quoted } => {
            (path, side, *start_line, *end_line, quoted)
        }
        CommentAnchor::Tour { step, section, element, target, .. } => {
            let at = step.map_or_else(|| "before the first section".to_owned(), |n| format!("{n}. {section}"));
            let (text, quoted) = match target {
                TourTarget::Text { quoted, .. } => (true, quoted),
                TourTarget::Element { label } => (false, label),
            };
            let header = format!("(tour{}) {at}, {}", if t.stale { ", stale" } else { "" }, spoken(element, text));
            let quote = if quoted.is_empty() { String::new() } else { format!("{}\n\n", quote(quoted)) };
            let body: Vec<String> = t.messages.iter().map(|m| signed(m, m.body.trim().to_owned())).collect();
            return format!("{header}\n\n{quote}{}\n\n---\n", body.join("\n\n"));
        }
    };
    let range = if start == end { start.to_string() } else { format!("{start}-{end}") };
    let mut prefixes = Vec::new();
    if *side == Side::Old {
        prefixes.push("(removed)".to_owned());
    }
    if t.stale {
        prefixes.push(format!("(stale, was line {})", t.stale_from_line.unwrap_or(start)));
    }
    let prefix = if prefixes.is_empty() { String::new() } else { prefixes.join(" ") + " " };
    let body: Vec<String> = t.messages.iter().map(|m| format_message(m, quoted)).collect();
    format!("{prefix}{path}:{range}\n\n{}\n\n{}\n\n---\n", quote(quoted), body.join("\n\n"))
}

/// `text` as a Markdown quote, line by line.
fn quote(text: &str) -> String {
    let lines: Vec<String> =
        text.split('\n').map(|l| if l.is_empty() { ">".to_owned() } else { format!("> {l}") }).collect();
    lines.join("\n")
}

fn format_message(m: &CommentMessage, quoted: &str) -> String {
    let parts: Vec<String> = parse_suggestions(&m.body)
        .into_iter()
        .map(|seg| match seg.code {
            None => seg.text.trim().to_owned(),
            Some(code) => format!("ORIGINAL:\n```\n{quoted}\n```\nSUGGESTED:\n```\n{code}\n```"),
        })
        .filter(|s| !s.is_empty())
        .collect();
    signed(m, parts.join("\n\n"))
}

/// Marks a message the agent wrote, so the prompt tells its words from the reviewer's.
fn signed(m: &CommentMessage, text: String) -> String {
    match m.author {
        Some(CommentAuthor::Agent) => format!("(agent) {text}"),
        None => text,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct BodySegment {
    /// Prose before or between suggestions; may be empty.
    pub text: String,
    /// Replacement code for the quoted range, when the segment is a ```suggestion fence.
    pub code: Option<String>,
}

/// Splits a body into prose and ```suggestion``` blocks, in order. Plain text yields one segment.
pub fn parse_suggestions(body: &str) -> Vec<BodySegment> {
    let mut out = Vec::new();
    let mut last = 0;
    for m in SUGGESTION_FENCE.captures_iter(body) {
        let whole = m.get(0).expect("match");
        let before = &body[last..whole.start()];
        if !before.trim().is_empty() {
            out.push(BodySegment { text: before.to_owned(), code: None });
        }
        out.push(BodySegment { text: String::new(), code: Some(m.get(1).map_or("", |c| c.as_str()).to_owned()) });
        last = whole.end();
    }
    let rest = &body[last..];
    if !rest.trim().is_empty() || out.is_empty() {
        out.push(BodySegment { text: rest.to_owned(), code: None });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(text: &str, code: Option<&str>) -> BodySegment {
        BodySegment { text: text.into(), code: code.map(Into::into) }
    }

    #[test]
    fn splits_prose_and_fences_in_order_keeps_plain_text_whole_and_accepts_an_empty_suggestion() {
        assert_eq!(parse_suggestions("just text"), [seg("just text", None)]);
        assert_eq!(parse_suggestions("```suggestion\n```"), [seg("", Some(""))]);
        assert_eq!(
            parse_suggestions("a\n```suggestion\nx\ny\n```\nb\n```suggestion\nz\n```"),
            [seg("a\n", None), seg("", Some("x\ny")), seg("\nb\n", None), seg("", Some("z"))]
        );
        // A regular code fence is prose.
        assert_eq!(parse_suggestions("```python\nx\n```"), [seg("```python\nx\n```", None)]);
    }
}
