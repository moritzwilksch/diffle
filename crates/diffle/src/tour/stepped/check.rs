//! A `diffle-check`: questions the reviewer ticks or answers. Its items are parts like a stepped
//! block's steps, each a line of inline prose, and each asks its own question across the tour: ticks
//! and answers find an item again by its question.
use super::{Findings, Kind, Others, steps};
use crate::tour::dom::{Dom, Node, NodeId};
use crate::tour::reading::{collapse, reading};

const KIND: Kind =
    Kind { block: "diffle-check", step: "diffle-item", noun: "checklist", word: "item", others: Others::Refused };

/// Checks the checklist at `node`, named `element`.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    let mut found = Findings::default();
    let earlier = items(dom, dom.section("body"));
    for item in steps(dom, node, element, &KIND, &mut found) {
        let question = collapse(&reading(dom, item.node));
        if question.is_empty() {
            found.error(item.node, item.element.clone(), "a diffle-item asks its question as its text");
        } else if earlier.iter().any(|&(at, ref asked)| at < item.node && *asked == question) {
            let message = "asks what an earlier item asks: a tick names an item by its question";
            found.error(item.node, item.element.clone(), message);
        }
    }
    found
}

/// Every checklist item under `node` with its question; node ids follow document order.
fn items(dom: &Dom, node: NodeId) -> Vec<(NodeId, String)> {
    dom.children(node)
        .iter()
        .flat_map(|&c| match dom.node(c) {
            Node::Element { name, .. } if &*name.local == "diffle-item" => vec![(c, collapse(&reading(dom, c)))],
            Node::Element { .. } => items(dom, c),
            _ => Vec::new(),
        })
        .collect()
}
