//! A `diffle-check`: questions the reviewer ticks or answers. Its items are parts like a stepped
//! block's steps, each a line of inline prose, and each asks its own question: ticks and answers
//! find an item again by its question.
use super::{Findings, Kind, Others, steps};
use crate::tour::dom::{Dom, NodeId};
use crate::tour::reading::reading;

const KIND: Kind =
    Kind { block: "diffle-check", step: "diffle-item", noun: "checklist", word: "item", others: Others::Refused };

/// Checks the checklist at `node`, named `element`.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    let mut found = Findings::default();
    let items = steps(dom, node, element, &KIND, &mut found);
    let questions: Vec<String> =
        items.iter().map(|item| reading(dom, item.node).split_whitespace().collect::<Vec<_>>().join(" ")).collect();
    for (i, item) in items.iter().enumerate() {
        if questions[i].is_empty() {
            found.error(item.node, item.element.clone(), "a diffle-item asks its question as its text");
        } else if let Some(j) = questions[..i].iter().position(|q| *q == questions[i]) {
            let message = format!("asks what item {} asks: each item asks its own question", j + 1);
            found.error(item.node, item.element.clone(), message);
        }
    }
    found
}
