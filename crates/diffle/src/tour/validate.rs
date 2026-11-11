//! Checks a tour document against the catalog in `protocol.ts` (`TourElement`, `TourTag`) and the
//! rules across elements: where each element may sit, unique card ids and steps.
use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::dom::{self, Dom, Node, NodeId};
use super::files::{Need, Reference};
use crate::protocol::{Side, TourElement, TourError, TourTag};

/// What a document asks of the snapshot, and what is wrong with it regardless.
pub struct Outline {
    /// Each with the node it is about, so errors sort into document order.
    pub errors: Vec<(NodeId, TourError)>,
    pub references: Vec<Reference>,
}

/// Where an element sits, deciding what it may hold.
#[derive(Clone, Copy, PartialEq)]
enum Place {
    Top,
    Group,
    Card { in_callout: bool },
}

/// An element's tag and attributes.
type Tag<'a> = (&'a str, &'a [(String, String)]);

/// What a `diffle-*` tag may hold and where it may sit.
#[derive(Clone, Copy, PartialEq)]
enum Rule {
    Card,
    Group,
    Callout,
    Jump,
    /// `diffle-diff`, `diffle-tree`, `diffle-symbol`: inside a card, holding nothing.
    Leaf,
}

impl Rule {
    fn of(tag: &str) -> Option<Self> {
        Some(match tag {
            "diffle-card" => Self::Card,
            "diffle-group" => Self::Group,
            "diffle-callout" => Self::Callout,
            "diffle-jump" => Self::Jump,
            "diffle-diff" | "diffle-tree" | "diffle-symbol" => Self::Leaf,
            _ => return None,
        })
    }

    fn fits(self, place: Place) -> bool {
        match self {
            Self::Card => matches!(place, Place::Top | Place::Group),
            Self::Group => place == Place::Top,
            Self::Callout => place == Place::Card { in_callout: false },
            Self::Jump | Self::Leaf => matches!(place, Place::Card { .. }),
        }
    }

    fn home(self) -> &'static str {
        match self {
            Self::Card => "at the top level or in a diffle-group",
            Self::Group => "at the top level",
            Self::Callout => "inside a diffle-card, outside other callouts",
            Self::Jump | Self::Leaf => "inside a diffle-card",
        }
    }
}

struct Card {
    node: NodeId,
    element: String,
    id: String,
    step: Option<String>,
}

#[derive(Default)]
struct Walk {
    errors: Vec<(NodeId, TourError)>,
    references: Vec<Reference>,
    cards: Vec<Card>,
}

/// Parses `html` and checks everything that needs no file of the review.
pub fn outline(html: &str) -> Outline {
    let dom = dom::parse(html);
    let mut walk = Walk::default();
    for &child in dom.children(dom.section("head")) {
        walk.visit(&dom, child, Place::Top, "");
    }
    for &child in dom.children(dom.section("body")) {
        walk.visit(&dom, child, Place::Top, "");
    }
    walk.across();
    Outline { errors: walk.errors, references: walk.references }
}

impl Walk {
    fn error(&mut self, node: NodeId, element: String, message: impl Into<String>) {
        self.errors.push((node, TourError { element, message: message.into() }));
    }

    fn visit(&mut self, dom: &Dom, node: NodeId, place: Place, context: &str) {
        match dom.node(node) {
            Node::Text(text) if !text.trim().is_empty() && !matches!(place, Place::Card { .. }) => {
                let element = format!("{context}text \"{}\"", short(text.trim()));
                self.error(node, element, "text belongs inside a diffle-card");
            }
            Node::Element { name, attrs } => {
                let tag = name.local.to_string();
                if name.ns != html5ever::ns!(html) {
                    let element = format!("{context}{}", label(&tag, attrs));
                    self.error(node, element, format!("<{tag}> is not allowed in a tour"));
                } else if tag.starts_with("diffle-") {
                    self.primitive(dom, node, place, (&tag, attrs), context);
                } else {
                    self.plain(dom, node, place, (&tag, attrs), context);
                }
            }
            _ => {}
        }
    }

    fn children(&mut self, dom: &Dom, node: NodeId, place: Place, context: &str) {
        for &child in dom.children(node) {
            self.visit(dom, child, place, context);
        }
    }

    fn plain(&mut self, dom: &Dom, node: NodeId, place: Place, (tag, attrs): Tag, context: &str) {
        let element = format!("{context}{}", label(tag, attrs));
        let Ok(known) = serde_json::from_value::<TourTag>(Value::String(tag.into())) else {
            return self.error(node, element, format!("<{tag}> is not allowed in a tour"));
        };
        if !matches!(place, Place::Card { .. }) {
            return self.error(node, element, format!("<{tag}> belongs inside a diffle-card"));
        }
        for (key, value) in attrs {
            let is_link = known == TourTag::A && key == "href";
            if !is_link {
                self.error(node, element.clone(), format!("<{tag}> takes no attribute {key}"));
            } else if !(value.starts_with("https://") || value.starts_with("http://")) {
                self.error(node, element.clone(), "href must be an http(s) URL");
            }
        }
        self.children(dom, node, place, context);
    }

    fn primitive(&mut self, dom: &Dom, node: NodeId, place: Place, (tag, attrs): Tag, context: &str) {
        let element = format!("{context}{}", label(tag, attrs));
        let parsed = element_of(tag, attrs).map_err(|message| explain(tag, attrs, message));
        let Some(rule) = Rule::of(tag) else {
            return self.error(node, element, parsed.err().unwrap_or_default());
        };
        let parsed = parsed.map_err(|message| self.error(node, element.clone(), message)).ok();
        let fits = rule.fits(place);
        if !fits {
            self.error(node, element.clone(), format!("{tag} belongs {}", rule.home()));
        }
        // What it holds is checked whatever its attributes, so one typo does not hide the rest.
        match rule {
            Rule::Card => {
                let id = attr(attrs, "id");
                let named = id.map_or_else(|| element.clone(), |id| format!("diffle-card#{id}"));
                if let Some(id) = id {
                    let step = attr(attrs, "step").map(Into::into);
                    self.cards.push(Card { node, element: element.clone(), id: id.into(), step });
                }
                self.children(dom, node, Place::Card { in_callout: false }, &format!("{named} > "));
            }
            Rule::Group => self.children(dom, node, Place::Group, &format!("{element} > ")),
            Rule::Callout => {
                let card = element.rsplit_once(" > ").map_or(String::new(), |(card, _)| format!("{card} > "));
                self.children(dom, node, Place::Card { in_callout: true }, &card);
            }
            Rule::Jump => {
                if dom.children(node).iter().any(|&c| !matches!(dom.node(c), Node::Text(_) | Node::Ignored)) {
                    self.error(node, element.clone(), "diffle-jump holds only its label text");
                }
            }
            Rule::Leaf => self.empty(dom, node, tag, &element),
        }
        if let (Some(parsed), true) = (parsed, fits) {
            self.refer(node, element, parsed);
        }
    }

    /// Notes what a well-placed element asks of the review's files.
    fn refer(&mut self, node: NodeId, element: String, parsed: TourElement) {
        let mut push = |path: &str, need: Need, element: String| {
            self.references.push(Reference { node, element, path: path.into(), need });
        };
        match parsed {
            TourElement::DiffleDiff { path, side, lines } => {
                let (start, end) =
                    lines.split_once('-').map_or((number(&lines), number(&lines)), |(a, b)| (number(a), number(b)));
                if start > end {
                    return self.error(node, element, format!("lines {} run backwards", *lines));
                }
                push(&path, Need::Lines { side: side.unwrap_or(Side::New), start, end }, element);
            }
            TourElement::DiffleTree { paths, root } => {
                let mut outside = Vec::new();
                for path in paths.lines().map(str::trim).filter(|p| !p.is_empty()) {
                    match root.as_deref() {
                        Some(root) if !path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/')) => {
                            outside.push(format!("{path} is not under the root {root}"));
                        }
                        _ => push(path, Need::File, element.clone()),
                    }
                }
                for message in outside {
                    self.error(node, element.clone(), message);
                }
            }
            TourElement::DiffleJump { path, line, side } => {
                let side = side.unwrap_or(Side::New);
                let need = line.map_or(Need::Side(side), |line| Need::Lines {
                    side,
                    start: number(&line),
                    end: number(&line),
                });
                push(&path, need, element);
            }
            TourElement::DiffleSymbol { path, line, name, side } => {
                let need = Need::Name { side: side.unwrap_or(Side::New), line: number(&line), name: name.to_string() };
                push(&path, need, element);
            }
            TourElement::DiffleCard { .. } | TourElement::DiffleGroup { .. } | TourElement::DiffleCallout { .. } => {}
        }
    }

    /// Refuses content in an element that holds none: HTML ignores `/>` on it, so what follows lands inside.
    fn empty(&mut self, dom: &Dom, node: NodeId, tag: &str, element: &str) {
        let holds = dom.children(node).iter().any(|&c| match dom.node(c) {
            Node::Text(text) => !text.trim().is_empty(),
            Node::Element { .. } => true,
            _ => false,
        });
        if holds {
            let message = format!("{tag} holds nothing; close it with </{tag}> right after it (HTML ignores />)");
            self.error(node, element.into(), message);
        }
    }

    /// The rules across elements: unique ids and steps, at least one card.
    fn across(&mut self) {
        let mut ids: HashSet<&str> = HashSet::new();
        let mut steps: HashMap<&str, &str> = HashMap::new();
        let mut found = Vec::new();
        for card in &self.cards {
            if !ids.insert(&card.id) {
                found.push((card.node, card.element.clone(), format!("id {} is taken by an earlier card", card.id)));
            }
            if let Some(step) = card.step.as_deref()
                && let Some(first) = steps.insert(step, &card.id)
            {
                found.push((card.node, card.element.clone(), format!("step {step} is taken by diffle-card#{first}")));
                steps.insert(step, first);
            }
        }
        if self.cards.is_empty() {
            found.push((0, "the document".into(), "a tour holds at least one diffle-card".into()));
        }
        for (node, element, message) in found {
            self.error(node, element, message);
        }
    }
}

/// The element `tag` with `attrs`, as the catalog in `protocol.ts` reads it.
fn element_of(tag: &str, attrs: &[(String, String)]) -> Result<TourElement, String> {
    let mut fields: Map<String, Value> = attrs.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    fields.insert("tag".into(), Value::String(tag.into()));
    serde_json::from_value(Value::Object(fields)).map_err(|e| e.to_string())
}

/// `message` naming the attribute whose value failed its pattern, which serde's message leaves out.
fn explain(tag: &str, attrs: &[(String, String)], message: String) -> String {
    if !message.starts_with("doesn't match pattern") {
        return message;
    }
    // Alone, a bad value fails on its pattern before any missing attribute is noticed.
    let culprit = attrs.iter().find(|a| element_of(tag, std::slice::from_ref(a)).is_err_and(|m| m == message));
    culprit.map_or(message.clone(), |(name, _)| format!("{name}: {message}"))
}

/// An attribute value the schema already matched as a positive number.
fn number(digits: &str) -> usize {
    digits.parse().unwrap_or(usize::MAX)
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// How an error names an element: its tag with its attributes as written.
fn label(tag: &str, attrs: &[(String, String)]) -> String {
    let attrs: String = attrs.iter().map(|(k, v)| format!(" {k}=\"{}\"", short(v))).collect();
    if tag.starts_with("diffle-") { format!("{tag}{attrs}") } else { format!("<{tag}{attrs}>") }
}

/// The first line of `text`, cut to 40 characters.
fn short(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default();
    let cut: String = line.chars().take(40).collect();
    if cut.len() < text.len() { format!("{cut}…") } else { cut }
}
