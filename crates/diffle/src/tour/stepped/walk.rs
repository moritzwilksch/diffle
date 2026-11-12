//! A `diffle-walk`: where its notes' lines lie, and the warning that keeps it to one piece of code.
use super::{Findings, Kind, Others, spell, steps};
use crate::protocol::TourElement;
use crate::tour::code::holds_markup;
use crate::tour::dom::{Dom, NodeId};
use crate::tour::element::parse;
use crate::tour::files::span;

pub const KIND: Kind =
    Kind { block: "diffle-walk", step: "diffle-note", noun: "walk", word: "note", others: Others::Refused };
/// Past this many lines a walk shows more than one piece of code.
const LONG_WALK: usize = 40;

/// Checks the walk at `node`, named `element`, as the catalog read it (none when it did not fit).
pub fn check(dom: &Dom, node: NodeId, element: &str, parsed: Option<&TourElement>) -> Findings {
    let lines = match parsed {
        Some(TourElement::DiffleWalk { lines, .. }) => Some(span(lines)),
        _ => None,
    };
    let mut found = Findings::default();
    // A code block the parser cut short moved what follows; its own refusal names the cause.
    if holds_markup(dom, node) {
        return found;
    }
    let notes = steps(dom, node, element, &KIND, &mut found);
    if let Some((start, end)) = lines.filter(|(start, end)| end - start + 1 > LONG_WALK) {
        let message = format!("Long for a walk, at {} lines: walk one piece of code, or split it", end - start + 1);
        found.warn(node, element.into(), message);
    }
    // A note whose attributes do not parse is refused for them already.
    let spans: Vec<_> = notes
        .iter()
        .filter_map(|note| match parse::<TourElement>("diffle-note", note.attrs) {
            Ok(TourElement::DiffleNote { lines: Some(lines), .. }) => Some((note, span(&lines))),
            Ok(_) => {
                found.error(note.node, note.element.clone(), "a note in a walk takes lines: the ones it explains");
                None
            }
            Err(_) => None,
        })
        .collect();
    for (i, (note, (start, end))) in spans.iter().enumerate() {
        if start > end {
            found.error(note.node, note.element.clone(), format!("{} run backwards", spell(*start, *end)));
            continue;
        }
        if let Some((from, to)) = lines.filter(|(from, to)| start < from || end > to) {
            let (lines, walk) = (spell(*start, *end), spell(from, to));
            let message = format!("{lines} leave the walk's {walk}: a note explains lines of its walk");
            found.error(note.node, note.element.clone(), message);
        }
        let earlier = spans[..i].iter().find(|(_, (a, b))| a <= b && a <= end && start <= b);
        if let Some((other, (a, b))) = earlier {
            let message =
                format!("Shares lines with note {} ({}): the reader sees them lit twice", other.number, spell(*a, *b));
            found.warn(note.node, note.element.clone(), message);
        }
    }
    found
}

#[cfg(test)]
mod tests {
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

        assert_eq!(found, ["Has 7 notes; past about 6 a walk is hard to follow: split it, or merge notes"]);
    }
}
