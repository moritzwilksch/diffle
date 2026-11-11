//! A stepped `diffle-diagram`: groups of its drawing take `step`, and one note per step explains
//! them in order.
use super::{Findings, Kind, Others, steps};
use crate::tour::dom::{Dom, Node, NodeId};

const KIND: Kind =
    Kind { block: "diffle-diagram", step: "diffle-note", noun: "diagram", word: "note", others: Others::Checked };

/// Checks the steps of the diagram at `node`, named `element`; a diagram without steps or notes has none to check.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    let mut found = Findings::default();
    let mut numbers = Vec::new();
    groups(dom, node, &mut numbers);
    let has_notes = dom.children(node).iter().any(|&c| is(dom, c, "diffle-note"));
    if numbers.is_empty() && !has_notes {
        return found;
    }
    let notes = steps(dom, node, element, &KIND, &mut found);
    if numbers.is_empty() {
        let message = "a diagram's notes step through its groups: give each <g> a note lights step=\"n\"";
        found.error(node, element.into(), message);
        return found;
    }
    numbers.sort_unstable();
    numbers.dedup();
    let count = *numbers.last().unwrap_or(&0);
    if let Some(missing) = (1..=count).find(|n| !numbers.contains(n)) {
        let message = format!("steps run 1 to {count} without a gap: no <g> takes step=\"{missing}\"");
        found.error(node, element.into(), message);
    }
    if !notes.is_empty() && notes.len() != count {
        let message = format!("has {count} steps and {} notes: one diffle-note per step, in order", notes.len());
        found.error(node, element.into(), message);
    }
    for note in &notes {
        if note.attrs.iter().any(|(key, _)| key == "lines") {
            let message = "a diagram's note takes no lines: it explains the step of its number";
            found.error(note.node, note.element.clone(), message);
        }
    }
    found
}

/// The `step` of every group in the drawing under `node`, where it parses as a number.
fn groups(dom: &Dom, node: NodeId, out: &mut Vec<usize>) {
    for &child in dom.children(node) {
        let Node::Element { name, attrs } = dom.node(child) else { continue };
        if &*name.local == "g"
            && let Some(step) = attrs.iter().find(|(k, _)| k == "step").and_then(|(_, v)| v.parse().ok())
        {
            out.push(step);
        }
        if &*name.local != "diffle-note" {
            groups(dom, child, out);
        }
    }
}

fn is(dom: &Dom, id: NodeId, tag: &str) -> bool {
    matches!(dom.node(id), Node::Element { name, .. } if &*name.local == tag)
}
