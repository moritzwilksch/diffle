//! Checks a `diffle-diagram`: one `<svg>` of the elements `TourSvgElement` allows, styled only by
//! `TourSvgClass`es, each refusal with its reason.
use html5ever::ns;

use super::dom::{Dom, Node, NodeId};
use super::element::{label, parse};
use crate::protocol::{TourError, TourSvgClass, TourSvgElement};

/// Where an element of the drawing sits, deciding what it may hold.
#[derive(Clone, Copy, PartialEq)]
enum Place {
    Root,
    Drawing,
    Text,
}

/// Every reason to refuse the `diffle-diagram` at `node`, which errors name as `element`.
pub fn check(dom: &Dom, node: NodeId, element: &str) -> Vec<(NodeId, TourError)> {
    let mut check = Check { dom, context: format!("{element} > "), errors: Vec::new() };
    let content: Vec<NodeId> = dom.children(node).iter().copied().filter(|&c| holds(dom.node(c))).collect();
    let is_svg = |&c: &NodeId| matches!(dom.node(c), Node::Element { name, .. } if &*name.local == "svg");
    if content.len() != 1 || !content.iter().all(is_svg) {
        check.error(node, element.into(), "diffle-diagram holds one <svg> and nothing else");
    }
    for child in content {
        check.visit(child, Place::Root);
    }
    check.errors
}

struct Check<'a> {
    dom: &'a Dom,
    context: String,
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
        let unknown = |e: &String| e.starts_with("unknown variant");
        let known = name.ns == ns!(svg) && !parse::<TourSvgElement>(tag, &[]).is_err_and(|e| unknown(&e));
        if !known {
            return self.error(node, element, refusal(tag));
        }
        let fits = match tag {
            "svg" => place == Place::Root,
            "tspan" => place == Place::Text,
            _ => place == Place::Drawing,
        };
        if !fits {
            let home = match tag {
                "svg" => "an <svg> holds no other <svg>",
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
        if let Err(message) = parse::<TourSvgElement>(tag, &geometry) {
            self.error(node, element.clone(), message);
        }
        let classes = geometry.iter().filter(|(key, _)| key == "class").flat_map(|(_, v)| v.split_whitespace());
        for word in classes {
            if parse_class(word).is_none() {
                self.error(node, element.clone(), format!("class {word} is not a diagram class"));
            }
        }
        let inner = if matches!(tag, "text" | "tspan") { Place::Text } else { Place::Drawing };
        for &child in self.dom.children(node) {
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

/// Whether a node is content: an element, or text that is not whitespace.
fn holds(node: &Node) -> bool {
    match node {
        Node::Text(text) => !text.trim().is_empty(),
        Node::Element { .. } => true,
        _ => false,
    }
}
