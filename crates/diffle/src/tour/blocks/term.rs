//! `diffle-term`s: each defines a term once, at its first use in prose. Later uses stay plain text;
//! the client shows the definition again at the first use in each later section.
use crate::tour::dom::{Dom, Node, NodeId};
use crate::tour::element::Findings;
use crate::tour::files::column;

/// Text in these says no term: code, headings, controls, a drawing and the terms themselves.
/// `src/client/tour/terms.ts` skips the same.
const PLAIN: &[&str] =
    &["h1", "h2", "h3", "h4", "code", "pre", "a", "svg", "diffle-code", "diffle-symbol", "diffle-jump", "diffle-term"];

/// A term as matched: its text, whitespace collapsed, lower-cased.
pub fn key(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Checks the `terms` of the document, each a `diffle-term` node with the name errors give it:
/// what each holds, a term defined twice, and a term the prose uses before defining it.
pub fn check(dom: &Dom, terms: &[(NodeId, String)]) -> Findings {
    let mut found = Findings::default();
    let mut defined: Vec<(String, NodeId, &str)> = Vec::new();
    for (node, element) in terms {
        if dom.children(*node).iter().any(|&c| matches!(dom.node(c), Node::Element { .. })) {
            found.error(*node, element.clone(), "diffle-term holds only the term, as text");
            continue;
        }
        let key = key(&dom.text(*node));
        if key.is_empty() {
            found.error(*node, element.clone(), "diffle-term holds the term it defines, as text");
        } else if defined.iter().any(|(k, _, _)| *k == key) {
            let message = format!(
                "\"{key}\" is defined already; later uses show its definition, so write this one as plain text"
            );
            found.error(*node, element.clone(), message);
        } else {
            defined.push((key, *node, element));
        }
    }
    let mut texts = Vec::new();
    prose(dom, dom.section("body"), &mut texts);
    for (key, node, element) in defined {
        // Node ids follow document order.
        let early = texts.iter().any(|&(at, ref text)| at < node && column(text, &key).is_some());
        if early {
            let message = format!("\"{key}\" is used before this definition: define a term at its first use");
            found.warn(node, element.into(), message);
        }
    }
    found
}

/// Every text node under `node` that can name a term, lower-cased with whitespace collapsed.
fn prose(dom: &Dom, node: NodeId, out: &mut Vec<(NodeId, String)>) {
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) => out.push((child, key(text))),
            Node::Element { name, .. } if !PLAIN.contains(&&*name.local) => prose(dom, child, out),
            _ => {}
        }
    }
}
