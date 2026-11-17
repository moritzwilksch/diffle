//! Checks the drawing of a `diffle-diagram` or a `diffle-morph`: one `<svg>` of the elements
//! `TourSvgElement` allows, styled only by `TourSvgClass`es from one palette, each refusal with its reason.
use html5ever::ns;

use super::dom::{Dom, Node, NodeId};
use super::element::{knows, label, parse};
use crate::protocol::{TourError, TourSvgClass, TourSvgElement, TourSvgIcon};

/// Where an element of the drawing sits, deciding what it may hold.
#[derive(Clone, Copy, PartialEq)]
enum Place {
    Root,
    Drawing,
    Text,
}

/// The block a drawing sits in, deciding what its groups take and what follows its `<svg>`.
#[derive(Clone, Copy, PartialEq)]
pub enum Block {
    /// A `diffle-diagram`: groups take `step`, and a `diffle-note` per step follows.
    Diagram,
    /// A `diffle-morph`: groups take `in` or `move`, and a `diffle-before` and a `diffle-after` follow.
    Morph,
}

/// Every reason to refuse the drawing of the block at `node`, which errors name as `element`.
pub fn check(dom: &Dom, node: NodeId, element: &str, block: Block) -> Vec<(NodeId, TourError)> {
    let mut check = Check { dom, context: format!("{element} > "), block, errors: Vec::new() };
    // What follows the drawing is checked as steps or states.
    let parts: &[&str] = match block {
        Block::Diagram => &["diffle-note"],
        Block::Morph => &["diffle-before", "diffle-after"],
    };
    let is_part = |c: NodeId| matches!(dom.node(c), Node::Element { name, .. } if parts.contains(&&*name.local));
    let content: Vec<NodeId> =
        dom.children(node).iter().copied().filter(|&c| holds(dom.node(c)) && !is_part(c)).collect();
    let is_svg = |&c: &NodeId| matches!(dom.node(c), Node::Element { name, .. } if &*name.local == "svg");
    if content.len() != 1 || !content.iter().all(is_svg) {
        let message = match block {
            Block::Diagram => "diffle-diagram holds one <svg>, then a diffle-note per step when its groups take step",
            Block::Morph => "diffle-morph holds one <svg>, then a diffle-before and a diffle-after",
        };
        check.error(node, element.into(), message);
    }
    for child in content {
        check.visit(child, Place::Root);
    }
    check.errors
}

struct Check<'a> {
    dom: &'a Dom,
    context: String,
    block: Block,
    errors: Vec<(NodeId, TourError)>,
}

impl Check<'_> {
    fn error(&mut self, node: NodeId, element: String, message: impl Into<String>) {
        self.errors.push((node, TourError { element, message: message.into() }));
    }

    fn visit(&mut self, node: NodeId, place: Place) {
        let (name, attrs) = match self.dom.node(node) {
            Node::Text(text) if place != Place::Text && !text.trim().is_empty() => {
                let element = format!("{}text \"{}\"", self.context, text.trim());
                return self.error(node, element, "text belongs in a <text> or <tspan>");
            }
            Node::Element { name, attrs } => (name, attrs),
            _ => return,
        };
        let tag = &*name.local;
        let element = format!("{}{}", self.context, label(tag, attrs));
        let known = name.ns == ns!(svg) && knows("TourSvgElement", tag);
        if !known {
            return self.error(node, element, refusal(tag));
        }
        // An `<svg>` in the drawing is an icon.
        let is_icon = tag == "svg" && place == Place::Drawing;
        let fits = match tag {
            "svg" => place != Place::Text,
            "tspan" => place == Place::Text,
            _ => place == Place::Drawing,
        };
        if !fits {
            let home = match tag {
                "tspan" => "<tspan> belongs in a <text>",
                _ if place == Place::Text => "<text> holds text and <tspan>s only",
                _ => "a diagram draws inside its <svg>",
            };
            self.error(node, element.clone(), home);
        }
        let (styling, geometry): (Vec<_>, Vec<_>) = attrs.iter().cloned().partition(|(key, _)| is_styling(key));
        for (key, _) in styling {
            self.error(node, element.clone(), format!("{key}: diffle styles diagrams; use its classes instead"));
        }
        let parsed = if is_icon {
            parse::<TourSvgIcon>(tag, &geometry).map(drop)
        } else {
            parse::<TourSvgElement>(tag, &geometry).map(drop)
        };
        if let Err(message) = parsed {
            self.error(node, element.clone(), message);
        }
        if is_icon && self.dom.children(node).iter().any(|&c| holds(self.dom.node(c))) {
            self.error(node, element.clone(), "an icon's <svg> holds nothing");
        }
        let keys = |names: &[&str]| geometry.iter().any(|(key, _)| names.contains(&key.as_str()));
        if tag == "g" && self.block == Block::Diagram && keys(&["in", "move"]) {
            self.error(
                node,
                element.clone(),
                "in and move tag a diffle-morph's groups: draw two states as a diffle-morph",
            );
        }
        if tag == "g" && self.block == Block::Morph && keys(&["step"]) {
            self.error(node, element.clone(), "a morph switches states, not steps: its groups take in or move");
        }
        let classes = geometry.iter().filter(|(key, _)| key == "class").flat_map(|(_, v)| v.split_whitespace());
        for word in classes {
            if parse_class(word).is_none() {
                self.error(node, element.clone(), format!("class {word} is not a diagram class"));
            }
        }
        let inner = if matches!(tag, "text" | "tspan") { Place::Text } else { Place::Drawing };
        let children = if is_icon { &[][..] } else { self.dom.children(node) };
        for &child in children {
            self.visit(child, inner);
        }
    }
}

/// Why `tag` has no place in a diagram.
fn refusal(tag: &str) -> String {
    match tag {
        "defs" | "marker" => "diffle draws the arrowheads: give the line the class arrow or arrows".into(),
        "style" => "diffle styles diagrams; use its classes instead".into(),
        _ => format!(
            "<{tag}> is not allowed in a diagram; draw with rect, circle, ellipse, polygon, g, path, line, polyline, text and tspan"
        ),
    }
}

/// Attributes that would style an element, which diffle does from its classes.
fn is_styling(key: &str) -> bool {
    matches!(key, "style" | "fill" | "stroke" | "color" | "opacity" | "transform")
        || ["stroke-", "fill-", "font", "marker", "text-"].iter().any(|prefix| key.starts_with(prefix))
}

fn parse_class(word: &str) -> Option<TourSvgClass> {
    serde_json::from_value(serde_json::Value::String(word.into())).ok()
}

/// The tones of the contrast palette; the rest (`accent` and the change tones) make up the other.
const CONTRAST: [&str; 2] = ["contrast-a", "contrast-b"];
const TONES: [&str; 6] = ["accent", "success", "error", "warning", "contrast-a", "contrast-b"];

/// The tone classes on the elements under `node`, each once, in the order first met.
pub fn tones(dom: &Dom, node: NodeId) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut stack = vec![node];
    while let Some(id) = stack.pop() {
        if let Node::Element { attrs, .. } = dom.node(id) {
            let words = attrs.iter().filter(|(k, _)| k == "class").flat_map(|(_, v)| v.split_whitespace());
            for word in words.filter(|w| TONES.contains(w)) {
                if !found.iter().any(|f| f == word) {
                    found.push(word.to_owned());
                }
            }
        }
        stack.extend(dom.children(id).iter().rev());
    }
    found
}

/// The warning for a diagram at `node` whose tones mix palettes, so no colour answers one question.
pub fn palette(dom: &Dom, node: NodeId, element: &str) -> Option<(NodeId, TourError)> {
    let (contrast, other): (Vec<String>, Vec<String>) =
        tones(dom, node).into_iter().partition(|t| CONTRAST.contains(&t.as_str()));
    (!contrast.is_empty() && !other.is_empty()).then(|| {
        let message = format!(
            "Mixes {} with {}: colour a drawing from one palette, accent and the change tones or contrast-a and contrast-b, so each colour answers one question",
            contrast.join(", "),
            other.join(", ")
        );
        (node, TourError { element: element.into(), message })
    })
}

/// Whether a node is content: an element, or text that is not whitespace.
fn holds(node: &Node) -> bool {
    match node {
        Node::Text(text) => !text.trim().is_empty(),
        Node::Element { .. } => true,
        _ => false,
    }
}
