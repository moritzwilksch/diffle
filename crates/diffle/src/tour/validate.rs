//! Checks a tour document against the catalog in `protocol.ts` (`TourElement`, `TourTag`) and the
//! rules across elements: where each element may sit, one title, at least one section.
use serde_json::Value;

use super::code::{self, Code};
use super::diagram;
use super::dom::{self, Dom, Node, NodeId};
use super::element::{label, parse, short};
use super::files::{Reference, asks};
use super::icon;
use super::layout;
use super::placement::{Place, Rule, is_column, misplaced};
use crate::protocol::{TourElement, TourError, TourTag};

/// What a document asks of the snapshot, and what is wrong with it regardless.
pub struct Outline {
    /// Each with the node it is about, so errors sort into document order.
    pub errors: Vec<(NodeId, TourError)>,
    /// Judgment calls about an accepted document, such as a diagram's layout.
    pub warnings: Vec<(NodeId, TourError)>,
    pub references: Vec<Reference>,
    /// The `diffle-code` blocks, whose warnings need the review's files.
    pub codes: Vec<Code>,
}

/// An element's tag and attributes.
type Tag<'a> = (&'a str, &'a [(String, String)]);

#[derive(Default)]
struct Walk {
    errors: Vec<(NodeId, TourError)>,
    warnings: Vec<(NodeId, TourError)>,
    references: Vec<Reference>,
    codes: Vec<Code>,
    /// The `h2` the walk is in, which names what errors are about.
    section: Option<String>,
    /// How many columns the row the walk is in has; 0 outside a row.
    row: usize,
    /// The card the walk is in, by its `id`.
    card: Option<String>,
    /// Each card's `id`, to find one taken twice.
    ids: Vec<(NodeId, String, String)>,
    /// Each `h1`, and whether an `h2` came before it.
    titles: Vec<(NodeId, String, bool)>,
    sections: usize,
}

/// Parses `html` and checks everything that needs no file of the review.
pub fn outline(html: &str) -> Outline {
    let dom = dom::parse(html);
    let mut walk = Walk::default();
    for &child in dom.children(dom.section("head")) {
        walk.visit(&dom, child, Place::TOP);
    }
    for &child in dom.children(dom.section("body")) {
        walk.visit(&dom, child, Place::TOP);
    }
    walk.across();
    Outline { errors: walk.errors, warnings: walk.warnings, references: walk.references, codes: walk.codes }
}

impl Walk {
    fn error(&mut self, node: NodeId, element: String, message: impl Into<String>) {
        self.errors.push((node, TourError { element, message: message.into() }));
    }

    /// What errors name an element after: the section it is in.
    fn context(&self) -> String {
        let section = self.section.as_ref().map_or_else(String::new, |title| format!("h2 \"{title}\" > "));
        let card = self.card.as_ref().map_or_else(String::new, |id| format!("diffle-card#{id} > "));
        format!("{section}{card}")
    }

    fn visit(&mut self, dom: &Dom, node: NodeId, place: Place) {
        let context = &self.context();
        match dom.node(node) {
            Node::Text(text) if !text.trim().is_empty() && place.top => {
                let element = format!("{context}text \"{}\"", short(text.trim()));
                self.error(node, element, "text belongs in a <p>, a list or another block");
            }
            Node::Element { name, attrs } => {
                let tag = name.local.to_string();
                if name.ns != html5ever::ns!(html) {
                    let element = format!("{context}{}", label(&tag, attrs));
                    let message = if tag == "svg" {
                        "<svg> belongs in a diffle-diagram".into()
                    } else {
                        format!("<{tag}> is not allowed in a tour")
                    };
                    self.error(node, element, message);
                } else if tag.starts_with("diffle-") {
                    self.primitive(dom, node, place, (&tag, attrs), context);
                } else {
                    self.plain(dom, node, place, (&tag, attrs), context);
                }
            }
            _ => {}
        }
    }

    fn children(&mut self, dom: &Dom, node: NodeId, place: Place) {
        for &child in dom.children(node) {
            self.visit(dom, child, place);
        }
    }

    fn plain(&mut self, dom: &Dom, node: NodeId, place: Place, (tag, attrs): Tag, context: &str) {
        let element = format!("{context}{}", label(tag, attrs));
        let Ok(known) = serde_json::from_value::<TourTag>(Value::String(tag.into())) else {
            return self.error(node, element, format!("<{tag}> is not allowed in a tour"));
        };
        if let Some(message) = misplaced(tag, place) {
            return self.error(node, element, message);
        }
        match tag {
            "h1" => self.titles.push((node, element.clone(), self.sections > 0)),
            "h2" => {
                self.sections += 1;
                self.section = Some(short(text_of(dom, node).trim()));
            }
            _ => {}
        }
        for (key, value) in attrs {
            let is_link = known == TourTag::A && key == "href";
            let is_span = matches!(known, TourTag::Th | TourTag::Td) && matches!(key.as_str(), "colspan" | "rowspan");
            if is_link && !(value.starts_with("https://") || value.starts_with("http://")) {
                self.error(node, element.clone(), "href must be an http(s) URL");
            } else if is_span && !is_count(value) {
                self.error(node, element.clone(), format!("{key} must be a positive number"));
            } else if !is_link && !is_span {
                self.error(node, element.clone(), format!("<{tag}> takes no attribute {key}"));
            }
        }
        self.children(dom, node, place.within(tag));
    }

    fn primitive(&mut self, dom: &Dom, node: NodeId, place: Place, (tag, attrs): Tag, context: &str) {
        let element = format!("{context}{}", label(tag, attrs));
        let parsed = parse::<TourElement>(tag, attrs);
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
                let id = attr(attrs, "id").map(str::to_owned);
                if let Some(id) = &id {
                    self.ids.push((node, element.clone(), id.clone()));
                }
                let outer = std::mem::replace(&mut self.card, id.or_else(|| Some(String::new())));
                self.children(dom, node, Place { top: false, in_card: true, ..place });
                self.card = outer;
                if !holds_diff(dom, node) {
                    self.error(
                        node,
                        element.clone(),
                        "a diffle-card explains part of the diff: it holds a diffle-diff",
                    );
                }
            }
            Rule::Row => self.row(dom, node, place, &element),
            Rule::Code => {
                if dom.children(node).iter().any(|&c| matches!(dom.node(c), Node::Element { .. })) {
                    let message = "diffle-code holds its code as text: write < as &lt; and & as &amp;";
                    self.error(node, element.clone(), message);
                }
                let path = attr(attrs, "path").map(str::to_owned);
                if path.is_none() && attr(attrs, "lang").is_none() {
                    self.error(node, element.clone(), "diffle-code takes lang when it has no path to name it");
                }
                let line = attr(attrs, "line").and_then(|l| l.parse().ok());
                if line.is_some() && path.is_none() {
                    self.error(node, element.clone(), "line counts in a path: give diffle-code its path");
                }
                let lines = code::lines(&text_of(dom, node));
                self.codes.push(Code { node, element: element.clone(), path, line, lines });
            }
            Rule::Callout => {
                let inside = Place { top: false, in_callout: true, ..place };
                self.children(dom, node, inside);
            }
            Rule::Jump => {
                if dom.children(node).iter().any(|&c| !matches!(dom.node(c), Node::Text(_) | Node::Ignored)) {
                    self.error(node, element.clone(), "diffle-jump holds only its label text");
                }
            }
            Rule::Diagram => {
                self.errors.extend(diagram::check(dom, node, &element));
                self.warnings.extend(layout::warnings(dom, node, &element, self.row));
            }
            Rule::Block | Rule::Symbol | Rule::Icon => {
                self.empty(dom, node, tag, &element);
                if tag == "diffle-diff" && self.row > 0 {
                    let message = format!(
                        "Lines in this diff may wrap: a column in a row of {} is about {} wide",
                        if self.row == 2 { "two" } else { "three" },
                        layout::column_width(self.row).round()
                    );
                    self.warnings.push((node, TourError { element: element.clone(), message }));
                }
            }
        }
        let named = match &parsed {
            Some(TourElement::DiffleIcon { name, .. }) => Some(name.as_str()),
            Some(TourElement::DiffleCard { icon, .. }) => icon.as_ref().map(|icon| icon.as_str()),
            _ => None,
        };
        if let Some(message) = named.and_then(icon::refusal) {
            self.error(node, element.clone(), message);
        }
        if let (Some(parsed), true) = (parsed, fits) {
            self.refer(node, element, parsed);
        }
    }

    /// Checks a `diffle-row`'s columns, then what they hold.
    fn row(&mut self, dom: &Dom, node: NodeId, place: Place, element: &str) {
        let context = self.context();
        let mut columns = 0;
        for &child in dom.children(node) {
            match dom.node(child) {
                Node::Text(text) if !text.trim().is_empty() => {
                    let message = "text in a diffle-row belongs in a column: a <p> or a <div>";
                    self.error(child, format!("{context}text \"{}\"", short(text.trim())), message);
                }
                Node::Element { name, attrs } => {
                    columns += 1;
                    if !is_column(&name.local) {
                        let message = "a column of a diffle-row is a block, or prose in a <div>, <p>, <ul> or <ol>";
                        self.error(child, format!("{context}{}", label(&name.local, attrs)), message);
                    }
                }
                _ => {}
            }
        }
        if !(2..=3).contains(&columns) {
            self.error(node, element.into(), format!("a diffle-row holds two or three columns, not {columns}"));
        }
        let outer = std::mem::replace(&mut self.row, columns);
        self.children(dom, node, Place { top: false, ..place });
        self.row = outer;
    }

    /// Notes what a well-placed element asks of the review's files.
    fn refer(&mut self, node: NodeId, element: String, parsed: TourElement) {
        let (needs, errors) = asks(parsed);
        for (path, need) in needs {
            self.references.push(Reference { node, element: element.clone(), path, need });
        }
        for message in errors {
            self.error(node, element.clone(), message);
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

    /// The rules across elements: unique card ids, one `h1` before every section, at least one section.
    fn across(&mut self) {
        let ids = std::mem::take(&mut self.ids);
        for (i, (node, element, id)) in ids.iter().enumerate() {
            if ids[..i].iter().any(|(_, _, earlier)| earlier == id) {
                self.error(*node, element.clone(), format!("id {id} is taken by an earlier card"));
            }
        }
        let titles = std::mem::take(&mut self.titles);
        for (i, (node, element, late)) in titles.into_iter().enumerate() {
            if i > 0 {
                self.error(node, element, "a tour has one <h1>, its title");
            } else if late {
                self.error(node, element, "<h1> comes before the first <h2>: it titles the tour");
            }
        }
        if self.sections == 0 {
            self.error(0, "the document".into(), "a tour holds at least one <h2>: each starts a step of the walk");
        }
    }
}

/// Whether a `diffle-diff` sits anywhere inside `node`.
fn holds_diff(dom: &Dom, node: NodeId) -> bool {
    dom.children(node).iter().any(|&c| match dom.node(c) {
        Node::Element { name, .. } => &*name.local == "diffle-diff" || holds_diff(dom, c),
        _ => false,
    })
}

/// The text inside `node`, as a heading reads.
fn text_of(dom: &Dom, node: NodeId) -> String {
    dom.children(node)
        .iter()
        .map(|&c| match dom.node(c) {
            Node::Text(text) => text.to_string(),
            Node::Element { .. } => text_of(dom, c),
            _ => String::new(),
        })
        .collect()
}

/// Whether `value` spells a positive number, as `colspan` and `rowspan` take one.
fn is_count(value: &str) -> bool {
    value.parse::<u16>().is_ok_and(|n| n > 0) && !value.starts_with('0')
}

fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}
