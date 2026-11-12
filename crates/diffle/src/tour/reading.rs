//! What a reader sees of a tour element, defined once on the server: threads quote it, and a
//! selection matches it with whitespace ignored. `src/client/tour/anchor.ts` reads the rendered page alike.
use super::dom::{Dom, Node, NodeId};
use super::drawing::get;

/// Blocks whose content is code or a drawing, not reading text: they take a thread as a whole.
pub const OPAQUE: [&str; 4] = ["diffle-diff", "diffle-code", "diffle-tree", "diffle-diagram"];

/// What a reader sees of `id`: its text, a symbol's name, a jump's label, a card's title before its
/// content; code and drawings add nothing. `src/client/tour/anchor.ts` reads the rendered page alike.
pub fn reading(dom: &Dom, id: NodeId) -> String {
    match dom.node(id) {
        Node::Text(t) => t.clone(),
        Node::Element { name, attrs } => match &*name.local {
            "diffle-symbol" => get(attrs, "name").to_owned(),
            "diffle-jump" => {
                let own = dom.text(id);
                if !own.trim().is_empty() {
                    return own;
                }
                let line = get(attrs, "line");
                if line.is_empty() { get(attrs, "path").to_owned() } else { format!("{}:{line}", get(attrs, "path")) }
            }
            tag if OPAQUE.contains(&tag) || tag == "diffle-icon" => String::new(),
            tag => {
                let inner: String = dom.children(id).iter().map(|&c| reading(dom, c)).collect();
                let titled = matches!(tag, "diffle-card" | "diffle-note" | "diffle-tab");
                if titled { format!("{} {inner}", get(attrs, "title")) } else { inner }
            }
        },
        _ => String::new(),
    }
}

/// `text` with each whitespace run one space, trimmed.
pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `text` without whitespace: a selection and the element's text agree on everything else.
pub fn squash(text: &str) -> String {
    text.split_whitespace().collect()
}

/// How many times `quoted` occurs in `reading`, whitespace ignored, overlaps included.
pub fn matches(reading: &str, quoted: &str) -> usize {
    let quoted = squash(quoted);
    if quoted.is_empty() {
        return 0;
    }
    (0..reading.len()).filter(|&i| reading.is_char_boundary(i) && reading[i..].starts_with(&quoted)).count()
}
