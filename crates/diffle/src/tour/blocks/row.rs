//! A `diffle-row`: two or three columns side by side, each a block or short prose, and no code of
//! the review: its lines are as wide as the production code and wrap in a column.
use crate::tour::code::holds_markup;
use crate::tour::dom::{Dom, Node, NodeId};
use crate::tour::element::{Findings, attr, label, short};
use crate::tour::placement::is_column;

/// What is wrong with the columns of the `diffle-row` at `node`, named `element`; `context` names
/// what sits in it.
pub fn check(dom: &Dom, node: NodeId, element: &str, context: &str) -> Findings {
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
                let code = review_code(dom, child);
                // A column holding the review's code (a card, a diff) is refused for that alone.
                if !is_column(&name.local) && code.is_empty() {
                    let message = "a column of a diffle-row is a block, or prose in a <div>, <p>, <ul> or <ol>";
                    found.error(child, format!("{context}{}", label(&name.local, attrs)), message);
                }
                for (code, name) in code {
                    let message = "code of the review wraps its lines in a column: place it full width, outside the diffle-row. Only made-up code sits in a row: a diffle-code with example, or with lang and no path";
                    found.error(code, format!("{context}{name}"), message);
                }
            }
            _ => {}
        }
    }
    // A code block the parser cut short moved what follows; its own refusal names the cause.
    if cut {
        return Findings::default();
    }
    if !(2..=3).contains(&columns) {
        found.error(node, element.into(), format!("a diffle-row holds two or three columns, not {columns}"));
    }
    found
}

/// The blocks at or under `node` that show code of the review, each with its label: a diff, a walk,
/// a trace, a versus whose steps name their lines, a `diffle-code` with `path`.
fn review_code(dom: &Dom, node: NodeId) -> Vec<(NodeId, String)> {
    let Node::Element { name, attrs } = dom.node(node) else { return Vec::new() };
    let shows = match &*name.local {
        "diffle-diff" | "diffle-walk" | "diffle-trace" => true,
        "diffle-versus" => names_lines(dom, node),
        "diffle-code" => attr(attrs, "path").is_some(),
        _ => false,
    };
    if shows {
        return vec![(node, label(&name.local, attrs))];
    }
    dom.children(node).iter().flat_map(|&child| review_code(dom, child)).collect()
}

/// Whether an element under `node` names a file of the review, as a versus step's place does.
fn names_lines(dom: &Dom, node: NodeId) -> bool {
    dom.children(node).iter().any(|&child| match dom.node(child) {
        Node::Element { attrs, .. } => attr(attrs, "path").is_some() || names_lines(dom, child),
        _ => false,
    })
}
