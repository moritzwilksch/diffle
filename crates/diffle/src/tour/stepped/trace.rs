//! A `diffle-trace`: stops in call order, each a line of the review checked as a diff's lines are.
use super::{Findings, Kind, Others, steps};
use crate::tour::code::holds_markup;
use crate::tour::dom::{Dom, NodeId};

const KIND: Kind =
    Kind { block: "diffle-trace", step: "diffle-stop", noun: "trace", word: "stop", others: Others::Refused };

/// Checks the trace at `node`, named `element`; each stop's file and line are checked as references.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    let mut found = Findings::default();
    // A code block the parser cut short moved what follows; its own refusal names the cause.
    if holds_markup(dom, node) {
        return found;
    }
    let stops = steps(dom, node, element, &KIND, &mut found);
    if stops.len() == 1 {
        let message = "Has one stop: a trace follows a path across places; show one place with diffle-diff";
        found.warn(node, element.into(), message);
    }
    found
}
