//! A `diffle-code` block: what its attributes may combine, and whether the parser cut one short.
use super::dom::{Dom, Node, NodeId};

/// Whether a `diffle-code` under `node` holds markup: a raw `<` the parser read as a tag, which may
/// have cut the block short and moved what follows into or beside it.
pub fn holds_markup(dom: &Dom, node: NodeId) -> bool {
    dom.children(node).iter().any(|&c| match dom.node(c) {
        Node::Element { name, .. } if &*name.local == "diffle-code" => {
            dom.children(c).iter().any(|&g| matches!(dom.node(g), Node::Element { .. }))
        }
        Node::Element { .. } => holds_markup(dom, c),
        _ => false,
    })
}

/// Why a `diffle-code` with `attrs` is refused: attributes that do not go together.
pub fn refusals(attrs: &[(String, String)]) -> Vec<&'static str> {
    let has = |name: &str| attrs.iter().any(|(key, _)| key == name);
    let mut found = Vec::new();
    if has("example") && (has("path") || has("line")) {
        found.push("an example is made up, not from a file: it takes no path or line");
    } else if has("line") && !has("path") {
        found.push("line counts in a path: give diffle-code its path");
    }
    if !has("path") && !has("lang") {
        found.push("diffle-code takes lang when it has no path to name it");
    }
    if has("title") && !has("example") {
        found.push("title names an example: add example, or drop title");
    }
    found
}
