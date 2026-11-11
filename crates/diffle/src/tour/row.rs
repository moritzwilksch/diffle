//! A `diffle-row`: two or three columns side by side, each a block or short prose.
use super::code::holds_markup;
use super::dom::{Dom, Node, NodeId};
use super::element::{Findings, label, short};
use super::placement::is_column;

/// How many columns the `diffle-row` at `node`, named `element`, has, and what is wrong with them;
/// `context` names what sits in it.
pub fn check(dom: &Dom, node: NodeId, element: &str, context: &str) -> (usize, Findings) {
    let mut found = Findings::default();
    let cut = holds_markup(dom, node);
    let mut columns = 0;
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) if !text.trim().is_empty() => {
                let message = "text in a diffle-row belongs in a column: a <p> or a <div>";
                found.error(child, format!("{context}text \"{}\"", short(text.trim())), message);
            }
            Node::Element { name, attrs } => {
                columns += 1;
                if !is_column(&name.local) {
                    let message = "a column of a diffle-row is a block, or prose in a <div>, <p>, <ul> or <ol>";
                    found.error(child, format!("{context}{}", label(&name.local, attrs)), message);
                }
            }
            _ => {}
        }
    }
    // A code block the parser cut short moved what follows; its own refusal names the cause.
    if cut {
        return (columns, Findings::default());
    }
    if !(2..=3).contains(&columns) {
        found.error(node, element.into(), format!("a diffle-row holds two or three columns, not {columns}"));
    }
    (columns, found)
}
