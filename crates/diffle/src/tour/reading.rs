//! What a reader sees of a tour element: the words a tree's note counts.
use super::dom::{Dom, Node, NodeId};
use super::element::attr;

/// What a reader sees of `id`: its text, a symbol's name, a jump's label, a card's title before its
/// content.
pub fn reading(dom: &Dom, id: NodeId) -> String {
    match dom.node(id) {
        Node::Text(t) => t.clone(),
        Node::Element { name, attrs } => match &*name.local {
            "diffle-symbol" => attr(attrs, "name").unwrap_or_default().to_owned(),
            "diffle-jump" => {
                let own = dom.text(id);
                if !own.trim().is_empty() {
                    return own;
                }
                let line = attr(attrs, "line").unwrap_or_default();
                if line.is_empty() {
                    attr(attrs, "path").unwrap_or_default().to_owned()
                } else {
                    format!("{}:{line}", attr(attrs, "path").unwrap_or_default())
                }
            }
            "diffle-icon" => String::new(),
            tag => {
                let inner: String = dom.children(id).iter().map(|&c| reading(dom, c)).collect();
                let titled = matches!(tag, "diffle-card" | "diffle-tab");
                if titled { format!("{} {inner}", attr(attrs, "title").unwrap_or_default()) } else { inner }
            }
        },
        _ => String::new(),
    }
}
