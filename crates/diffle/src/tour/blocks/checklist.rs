//! A `diffle-check`: questions the reviewer ticks or answers. Its items are its parts, each a line of
//! inline prose, and each asks its own question across the tour: ticks and answers find an item
//! again by its question.
use crate::tour::code::holds_markup;
use crate::tour::dom::{Dom, Node, NodeId};
use crate::tour::element::{Findings, label, short};
use crate::tour::placement::fits_sentence;
use crate::tour::reading::{collapse, reading};

/// Past this many items a checklist is hard to keep in mind.
const MANY: usize = 6;
/// Past this many sentences an item stops being one question.
const LONG: usize = 2;

/// The items of the checklist at `node`; what else it holds `check` refuses.
pub fn parts(dom: &Dom, node: NodeId) -> Vec<NodeId> {
    dom.children(node).iter().copied().filter(|&c| is_item(dom, c)).collect()
}

/// Checks the checklist at `node`, named `element`.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    let mut found = Findings::default();
    // A code block the parser cut short moved what follows; its own refusal names the cause.
    if holds_markup(dom, node) {
        return found;
    }
    let earlier = items(dom, dom.section("body"));
    let mut count = 0;
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) if !text.trim().is_empty() => {
                let name = format!("{element} > text \"{}\"", short(text.trim()));
                found.error(child, name, "a diffle-check holds only diffle-items: text belongs in a item");
            }
            Node::Element { attrs, .. } if is_item(dom, child) => {
                count += 1;
                let name = format!("{element} > {}", label("diffle-item", attrs));
                sentence(dom, child, &name, &mut found);
                let question = collapse(&reading(dom, child));
                if question.is_empty() {
                    found.error(child, name, "a diffle-item asks its question as its text");
                } else if earlier.iter().any(|&(at, ref asked)| at < child && *asked == question) {
                    let message = "asks what an earlier item asks: a tick names an item by its question";
                    found.error(child, name, message);
                }
            }
            Node::Element { name, attrs } => {
                let name = format!("{element} > {}", label(&name.local, attrs));
                found.error(child, name, "a diffle-check holds only diffle-items: prose goes before or after it");
            }
            _ => {}
        }
    }
    if count == 0 {
        let message = "a diffle-check holds at least one diffle-item: one per step, in reading order";
        found.error(node, element.into(), message);
    } else if count > MANY {
        let message =
            format!("Has {count} items; past about {MANY} a checklist is hard to follow: split it, or merge items");
        found.warn(node, element.into(), message);
    }
    found
}

fn is_item(dom: &Dom, id: NodeId) -> bool {
    matches!(dom.node(id), Node::Element { name, .. } if &*name.local == "diffle-item")
}

/// Checks what an item holds: a sentence or two of inline prose.
fn sentence(dom: &Dom, node: NodeId, element: &str, found: &mut Findings) {
    let text: String = dom.children(node).iter().map(|&c| reading(dom, c)).collect();
    let sentences = sentences(&text);
    if sentences > LONG {
        let message = format!("May be long for a item, at about {sentences} sentences: keep it to one or two");
        found.warn(node, element.into(), message);
    }
    let mut stack: Vec<NodeId> = dom.children(node).to_vec();
    while let Some(id) = stack.pop() {
        let Node::Element { name, attrs } = dom.node(id) else { continue };
        let tag = &*name.local;
        if !fits_sentence(tag) {
            let message = "a item holds a sentence or two: text, <code>, <strong>, <em>, <a> and inline primitives";
            found.error(id, format!("{element} > {}", label(tag, attrs)), message);
        }
        stack.extend(dom.children(id));
    }
}

/// About how many sentences `text` holds: runs ending in `.`, `!` or `?` before a space or the end.
fn sentences(text: &str) -> usize {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let ends = text
        .match_indices(['.', '!', '?'])
        .filter(|(at, _)| text[at + 1..].is_empty() || text[at + 1..].starts_with(' '));
    let mut count = ends.count();
    if !text.trim_end().ends_with(['.', '!', '?']) && !text.trim().is_empty() {
        count += 1;
    }
    count
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

#[cfg(test)]
mod tests {
    use super::sentences;

    #[test]
    fn counts_sentences_by_their_ends() {
        assert_eq!(sentences("Collects what each account sold."), 1);
        assert_eq!(sentences("Reads entry.kind first. Then the rest"), 2);
        assert_eq!(sentences("One. Two! Three?"), 3);
    }
}
