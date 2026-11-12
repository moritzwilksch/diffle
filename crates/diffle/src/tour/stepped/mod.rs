//! Stepped blocks: a walk, a trace and a stepped diagram each hold steps the reader takes one at a
//! time, each a sentence of inline prose. What their steps share is checked here, a checklist's
//! items included; each block's own rules sit in its module.
pub mod diagram;
pub mod trace;
pub mod walk;

use super::dom::{Dom, Node, NodeId};
pub use super::element::Findings;
use super::element::{label, short};
use super::placement::fits_sentence;
use super::reading::reading;

/// Past this many steps a block is hard to keep in mind.
const MANY: usize = 6;
/// Past this many sentences a step's text stops being a caption.
const LONG: usize = 2;

/// One step of a block, as its element is named in errors.
pub struct Step<'a> {
    pub node: NodeId,
    pub element: String,
    /// Its number in the block, from 1.
    pub number: usize,
    pub attrs: &'a [(String, String)],
}

/// The kind of step a block holds: its tag, and what else it may hold beside its steps.
pub struct Kind {
    pub block: &'static str,
    pub step: &'static str,
    /// The words a reader uses for the block and for one step: `walk` and `note`.
    pub noun: &'static str,
    pub word: &'static str,
    /// Who refuses what the block holds besides its steps.
    pub others: Others,
}

/// Who refuses what a stepped block holds besides its steps.
pub enum Others {
    /// `steps` does: the block holds its steps alone.
    Refused,
    /// The block's own check does, as a diagram's checks its `<svg>`.
    Checked,
}

/// The steps of the block at `node`, named `element`, each checked as a sentence of inline prose;
/// refuses what else it holds and a block without steps, and warns of too many.
pub fn steps<'a>(dom: &'a Dom, node: NodeId, element: &str, kind: &Kind, found: &mut Findings) -> Vec<Step<'a>> {
    let Kind { block, step, noun, word, others } = kind;
    let checked = matches!(others, Others::Checked);
    let mut steps = Vec::new();
    for &child in dom.children(node) {
        match dom.node(child) {
            Node::Text(text) if !checked && !text.trim().is_empty() => {
                let name = format!("{element} > text \"{}\"", short(text.trim()));
                found.error(child, name, format!("a {block} holds only {step}s: text belongs in a {word}"));
            }
            Node::Element { name, attrs } if &*name.local == *step => {
                let name = format!("{element} > {}", label(step, attrs));
                sentence(dom, child, &name, word, found);
                steps.push(Step { node: child, element: name, number: steps.len() + 1, attrs });
            }
            Node::Element { .. } if checked => {}
            Node::Element { name, attrs } => {
                let name = format!("{element} > {}", label(&name.local, attrs));
                found.error(child, name, format!("a {block} holds only {step}s: prose goes before or after it"));
            }
            _ => {}
        }
    }
    let count = steps.len();
    if count == 0 {
        let message = format!("a {block} holds at least one {step}: one per step, in reading order");
        found.error(node, element.into(), message);
    } else if count > MANY {
        let message =
            format!("Has {count} {word}s; past about {MANY} a {noun} is hard to follow: split it, or merge {word}s");
        found.warn(node, element.into(), message);
    }
    steps
}

/// The steps of the block at `node`, its notes or stops; what else it holds `steps` refuses, and
/// its content would only repeat that.
pub fn step_nodes(dom: &Dom, node: NodeId) -> Vec<NodeId> {
    let is_step = |&&c: &&NodeId| matches!(dom.node(c), Node::Element { name, .. } if matches!(&*name.local, "diffle-note" | "diffle-stop" | "diffle-item"));
    dom.children(node).iter().filter(is_step).copied().collect()
}

/// Checks what a step holds: a sentence or two of inline prose.
fn sentence(dom: &Dom, node: NodeId, element: &str, word: &str, found: &mut Findings) {
    let text: String = dom.children(node).iter().map(|&c| reading(dom, c)).collect();
    let sentences = sentences(&text);
    if sentences > LONG {
        let message = format!("May be long for a {word}, at about {sentences} sentences: keep it to one or two");
        found.warn(node, element.into(), message);
    }
    let mut stack: Vec<NodeId> = dom.children(node).to_vec();
    while let Some(id) = stack.pop() {
        let Node::Element { name, attrs } = dom.node(id) else { continue };
        let tag = &*name.local;
        if !fits_sentence(tag) {
            let message =
                format!("a {word} holds a sentence or two: text, <code>, <strong>, <em>, <a> and inline primitives");
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

/// A line range in words: `line 3`, `lines 3-5`.
pub fn spell(start: usize, end: usize) -> String {
    if start == end { format!("line {start}") } else { format!("lines {start}-{end}") }
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
