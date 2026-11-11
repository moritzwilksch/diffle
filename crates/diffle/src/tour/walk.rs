//! A `diffle-walk`: the notes it holds, where their lines lie, and the warnings that keep a walk
//! short enough to follow one note at a time.
use super::anchor::reading;
use super::dom::{Dom, Node, NodeId};
use super::element::{label, parse, short};
use super::files::span;
use crate::protocol::{TourElement, TourError};

/// Why a `diffle-note` without a title is refused, in place of the catalog's "missing field".
pub const UNTITLED: &str = "a diffle-note takes a title: what its lines do, in a few words";
/// Past this many notes a walk is hard to keep in mind.
const MANY_NOTES: usize = 6;
/// Past this many sentences a note stops being a caption.
const LONG_NOTE: usize = 2;
/// Past this many lines a walk shows more than one piece of code.
const LONG_WALK: usize = 40;
/// The plain tags a note's sentence may use.
const INLINE: [&str; 4] = ["code", "strong", "em", "a"];

/// What is wrong with a walk, and the judgment calls about it, each with the node it is about.
#[derive(Default)]
pub struct Findings {
    pub errors: Vec<(NodeId, TourError)>,
    pub warnings: Vec<(NodeId, TourError)>,
}

impl Findings {
    fn error(&mut self, node: NodeId, element: String, message: impl Into<String>) {
        self.errors.push((node, TourError { element, message: message.into() }));
    }

    fn warn(&mut self, node: NodeId, element: String, message: impl Into<String>) {
        self.warnings.push((node, TourError { element, message: message.into() }));
    }
}

/// The notes of the walk at `node`; what else it holds `check` refuses, and its content would only repeat that.
pub fn notes(dom: &Dom, node: NodeId) -> Vec<NodeId> {
    let is_note = |&&c: &&NodeId| matches!(dom.node(c), Node::Element { name, .. } if &*name.local == "diffle-note");
    dom.children(node).iter().filter(is_note).copied().collect()
}

/// Checks the walk at `node`, named `element`, as the catalog read it (none when it did not fit).
pub fn check(dom: &Dom, node: NodeId, element: &str, parsed: Option<&TourElement>) -> Findings {
    let lines = match parsed {
        Some(TourElement::DiffleWalk { lines, .. }) => Some(span(lines)),
        _ => None,
    };
    let mut found = Findings::default();
    // Each parsed note with its number in the walk and its lines.
    let mut notes: Vec<(NodeId, String, usize, (usize, usize))> = Vec::new();
    let mut count = 0;
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) if !text.trim().is_empty() => {
                let name = format!("{element} > text \"{}\"", short(text.trim()));
                found.error(child, name, "a diffle-walk holds only diffle-notes: text belongs in a note");
            }
            Node::Element { name, attrs } if &*name.local == "diffle-note" => {
                let name = format!("{element} > {}", label("diffle-note", attrs));
                note(dom, child, &name, &mut found);
                count += 1;
                // A note whose attributes do not parse is refused for them already.
                if let Ok(TourElement::DiffleNote { lines, .. }) = parse::<TourElement>("diffle-note", attrs) {
                    notes.push((child, name, count, span(&lines)));
                }
            }
            Node::Element { name, attrs } => {
                let name = format!("{element} > {}", label(&name.local, attrs));
                found.error(child, name, "a diffle-walk holds only diffle-notes: prose goes before or after it");
            }
            _ => {}
        }
    }
    if count == 0 {
        found.error(
            node,
            element.into(),
            "a diffle-walk holds at least one diffle-note: one per step, in reading order",
        );
    } else if count > MANY_NOTES {
        let message =
            format!("Has {count} notes; past about {MANY_NOTES} a walk is hard to follow: split it, or merge steps");
        found.warn(node, element.into(), message);
    }
    if let Some((start, end)) = lines.filter(|(start, end)| end - start + 1 > LONG_WALK) {
        let message = format!("Long for a walk, at {} lines: walk one piece of code, or split it", end - start + 1);
        found.warn(node, element.into(), message);
    }
    for (i, (child, name, _, (start, end))) in notes.iter().enumerate() {
        if start > end {
            found.error(*child, name.clone(), format!("{} run backwards", spell(*start, *end)));
            continue;
        }
        if let Some((from, to)) = lines.filter(|(from, to)| start < from || end > to) {
            let message = format!(
                "{} leave the walk's {}: a note explains lines of its walk",
                spell(*start, *end),
                spell(from, to)
            );
            found.error(*child, name.clone(), message);
        }
        let earlier = notes[..i].iter().find(|(_, _, _, (a, b))| a <= b && a <= end && start <= b);
        if let Some((_, _, number, (a, b))) = earlier {
            let message =
                format!("Shares lines with note {number} ({}): the reader sees them lit twice", spell(*a, *b));
            found.warn(*child, name.clone(), message);
        }
    }
    found
}

/// Checks what a note holds: a sentence or two of inline prose.
fn note(dom: &Dom, node: NodeId, element: &str, found: &mut Findings) {
    let text: String = dom.children(node).iter().map(|&c| reading(dom, c)).collect();
    let sentences = sentences(&text);
    if sentences > LONG_NOTE {
        let message = format!("May be long for a note, at about {sentences} sentences: keep it to one or two");
        found.warn(node, element.into(), message);
    }
    let mut stack: Vec<NodeId> = dom.children(node).to_vec();
    while let Some(id) = stack.pop() {
        let Node::Element { name, attrs } = dom.node(id) else { continue };
        let tag = &*name.local;
        if !tag.starts_with("diffle-") && !INLINE.contains(&tag) {
            let message =
                "a diffle-note holds a sentence or two: text, <code>, <strong>, <em>, <a> and inline primitives";
            found.error(id, format!("{element} > {}", label(tag, attrs)), message);
        }
        stack.extend(dom.children(id));
    }
}

/// About how many sentences `text` holds: runs ending in `.`, `!` or `?` before a space or the end.
fn sentences(text: &str) -> usize {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let ends = text
        .match_indices(['.', '!', '?'])
        .filter(|(at, _)| text[at + 1..].is_empty() || text[at + 1..].starts_with(' '));
    let mut count = ends.count();
    if !text.trim_end().ends_with(['.', '!', '?']) && !text.trim().is_empty() {
        count += 1;
    }
    count
}

/// A line range in words: `line 3`, `lines 3-5`.
fn spell(start: usize, end: usize) -> String {
    if start == end { format!("line {start}") } else { format!("lines {start}-{end}") }
}

#[cfg(test)]
mod tests {
    use super::sentences;
    use crate::tour::validate::outline;

    fn warnings(html: &str) -> Vec<String> {
        outline(&format!("<h2>A</h2>{html}")).warnings.into_iter().map(|(_, w)| w.message).collect()
    }

    #[test]
    fn warns_of_a_walk_past_about_forty_lines() {
        let walk =
            r#"<diffle-walk path="a.py" lines="1-50"><diffle-note lines="2" title="B">C.</diffle-note></diffle-walk>"#;

        assert_eq!(warnings(walk), ["Long for a walk, at 50 lines: walk one piece of code, or split it"]);
    }

    #[test]
    fn warns_of_a_walk_past_about_six_notes() {
        let notes: String =
            (1..=7).map(|n| format!(r#"<diffle-note lines="{n}" title="N">C.</diffle-note>"#)).collect();

        let found = warnings(&format!(r#"<diffle-walk path="a.py" lines="1-9">{notes}</diffle-walk>"#));

        assert_eq!(found, ["Has 7 notes; past about 6 a walk is hard to follow: split it, or merge steps"]);
    }

    #[test]
    fn counts_sentences_by_their_ends() {
        assert_eq!(sentences("Collects what each account sold."), 1);
        assert_eq!(sentences("Reads entry.kind first. Then the rest"), 2);
        assert_eq!(sentences("One. Two! Three?"), 3);
    }
}
