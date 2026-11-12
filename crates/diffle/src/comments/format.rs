//! The agent prompt a review exports as.
use std::sync::LazyLock;

use regex::Regex;

use super::anchor::compare_threads;
use crate::protocol::{
    CommentAnchor, CommentAuthor, CommentMessage, CommentThread, Side, TourCheckItem, TourCommentTag, TourPart,
    TourTarget,
};

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
///
/// After the threads come the tour's checklist items the reviewer has not settled by a tick alone,
/// in document order: `(check) 4. Heading, open` (or `decided` when ticked), the question quoted,
/// and the thread answering it, or `(no answer yet)`.
pub fn format_prompt(threads: &[CommentThread], checks: &[TourCheckItem]) -> String {
    let answers: Vec<&str> = checks.iter().filter_map(|c| c.thread.as_deref()).collect();
    let mut sorted: Vec<&CommentThread> = threads.iter().filter(|t| !answers.contains(&t.id.as_str())).collect();
    sorted.sort_by(|a, b| compare_threads(a, b));
    let items = checks.iter().filter_map(|item| {
        let thread = item.thread.as_deref().and_then(|id| threads.iter().find(|t| t.id == id));
        format_check(item, thread)
    });
    sorted.into_iter().map(format_one).chain(items).collect::<Vec<_>>().join("\n")
}

/// A checklist item, or none when a tick settled it without an answer.
fn format_check(item: &TourCheckItem, thread: Option<&CommentThread>) -> Option<String> {
    if item.ticked && thread.is_none() {
        return None;
    }
    let at = item.step.map_or_else(|| "before the first section".to_owned(), |n| format!("{n}. {}", item.section));
    let state = if item.ticked { "decided" } else { "open" };
    let body = thread.map_or_else(
        || "(no answer yet)".to_owned(),
        |t| t.messages.iter().map(|m| signed(m, m.body.trim().to_owned())).collect::<Vec<_>>().join("\n\n"),
    );
    Some(format!("(check) {at}, {state}\n\n{}\n\n{body}\n\n---\n", quote(&item.question)))
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
        CommentAnchor::Tour { step, section, element, within, target, .. } => {
            let at = step.map_or_else(|| "before the first section".to_owned(), |n| format!("{n}. {section}"));
            let (text, quoted) = match target {
                TourTarget::Text { quoted, .. } => (true, quoted),
                TourTarget::Element { label } => (false, label),
            };
            let header = format!(
                "(tour{}) {at}, {}",
                if t.stale { ", stale" } else { "" },
                spoken(element, within.as_ref(), text)
            );
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

/// How the prompt names the tour element a thread is on: its kind and the one handle an agent can
/// search its document for, never its geometry or the text the quote already shows; then the card
/// or tab holding it. `text` for a selection in it.
fn spoken(element: &TourPart, within: Option<&TourPart>, text: bool) -> String {
    use TourCommentTag as T;
    let handle = element.handle.as_deref().unwrap_or_default();
    // Every tag: one a thread can newly sit on must be given its words here.
    let name = match element.tag {
        T::DiffleCard => format!("the card #{handle}"),
        T::DiffleDiff => format!("the diff of {handle}"),
        T::DiffleTabs => "the tabs".into(),
        T::DiffleTab => format!("the tab \"{handle}\""),
        T::DiffleCheck => "a checklist".into(),
        T::DiffleItem => "an item of a checklist".into(),
        T::DiffleCode if element.handle.is_some() => format!("the code of {handle}"),
        T::DiffleCode => "a code block".into(),
        T::DiffleTree => format!("the tree \"{handle}\""),
        T::DiffleCallout => format!("a {handle} callout"),
        T::DiffleDiagram => "a diagram".into(),
        T::Rect => "a box in the diagram".into(),
        T::Text => "a label in the diagram".into(),
        T::H1
        | T::H2
        | T::H3
        | T::H4
        | T::P
        | T::Ul
        | T::Ol
        | T::Li
        | T::Code
        | T::Pre
        | T::Strong
        | T::Em
        | T::A
        | T::Div
        | T::Details
        | T::Summary
        | T::Table
        | T::Thead
        | T::Tbody
        | T::Tr
        | T::Th
        | T::Td
        | T::DiffleJump
        | T::DiffleSymbol
        | T::DiffleRow
        | T::DiffleIcon
        | T::DiffleFile => format!("a <{}>", element.tag),
    };
    let within = within.map_or_else(String::new, |w| {
        let handle = w.handle.as_deref().unwrap_or_default();
        match w.tag {
            T::DiffleCard => format!(" in the card #{handle}"),
            // The holders `TourIndex` names are a card and a tab.
            _ => format!(" in the tab \"{handle}\""),
        }
    });
    format!("{} {name}{within}", if text { "in" } else { "on" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(tag: &str, handle: Option<&str>) -> TourPart {
        TourPart { tag: tag.parse().unwrap(), handle: handle.map(Into::into) }
    }

    #[test]
    fn names_an_element_by_its_kind_and_handle() {
        let card = part("diffle-card", Some("entry"));
        assert_eq!(spoken(&card, None, false), "on the card #entry");
        assert_eq!(spoken(&part("p", None), Some(&card), true), "in a <p> in the card #entry");
        assert_eq!(
            spoken(&part("diffle-diff", Some("src/app.py:12-20")), Some(&card), false),
            "on the diff of src/app.py:12-20 in the card #entry"
        );
        assert_eq!(spoken(&part("rect", None), None, false), "on a box in the diagram");
        let tab = part("diffle-tab", Some("Chosen \"A\" > B"));
        assert_eq!(spoken(&part("p", None), Some(&tab), true), "in a <p> in the tab \"Chosen \"A\" > B\"");
    }

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
