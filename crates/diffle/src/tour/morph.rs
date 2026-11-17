//! A `diffle-morph`: one drawing in two states. Its groups say which state they are in or how far
//! they move, and one sentence each says what holds before and after; diffle colours the change.
use super::diagram::{self, Block};
use super::dom::{Dom, Node, NodeId};
use super::element::{Findings, attr, label};
use super::stepped::sentence;

/// Checks the morph at `node`, named `element`: its drawing, its tagged groups and its two sentences.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Findings {
    let mut found = Findings::default();
    found.errors.extend(diagram::check(dom, node, element, Block::Morph));
    for (tag, state) in [("diffle-before", "before"), ("diffle-after", "after")] {
        let states: Vec<(NodeId, &[(String, String)])> = dom
            .children(node)
            .iter()
            .filter_map(|&c| match dom.node(c) {
                Node::Element { name, attrs } if &*name.local == tag => Some((c, attrs.as_slice())),
                _ => None,
            })
            .collect();
        if states.len() != 1 {
            let message = format!("a diffle-morph holds one {tag}: a sentence on what holds {state} the change");
            found.error(node, element.into(), message);
        }
        for (state, attrs) in states {
            let name = format!("{element} > {}", label(tag, attrs));
            if ["path", "line", "tone"].iter().any(|key| attr(attrs, key).is_some()) {
                found.error(
                    state,
                    name.clone(),
                    "a morph's state takes no path, line or tone: it says what holds then",
                );
            }
            sentence(dom, state, &name, "state", &mut found);
        }
    }
    let mut tagged = 0;
    let Some(svg) = dom.children(node).iter().copied().find(|&c| is(dom, c, "svg")) else { return found };
    groups(dom, svg, &mut |group, attrs| {
        let (moves, within) = (attr(attrs, "move").is_some(), attr(attrs, "in").is_some());
        tagged += usize::from(moves || within);
        if moves && within {
            let message = "a group takes in or move, not both: a part in one state stays where it is";
            found.error(group, format!("{element} > {}", label("g", attrs)), message);
        }
    });
    if tagged == 0 {
        let message = "a morph's groups take in=\"before\", in=\"after\" or move=\"dx dy\": a drawing in one state is a diffle-diagram";
        found.error(node, element.into(), message);
    }
    let tones = diagram::tones(dom, svg);
    if !tones.is_empty() {
        let message = format!(
            "Tones its parts ({}): diffle colours a morph's change in its Diff, so draw the parts plain",
            tones.join(", ")
        );
        found.warn(node, element.into(), message);
    }
    found
}

/// Calls `each` with every group in the drawing under `node` and its attributes.
fn groups(dom: &Dom, node: NodeId, each: &mut impl FnMut(NodeId, &[(String, String)])) {
    for &child in dom.children(node) {
        if let Node::Element { name, attrs } = dom.node(child) {
            if &*name.local == "g" {
                each(child, attrs);
            }
            groups(dom, child, each);
        }
    }
}

fn is(dom: &Dom, id: NodeId, tag: &str) -> bool {
    matches!(dom.node(id), Node::Element { name, .. } if &*name.local == tag)
}
