//! Where a thread sits in a tour: each element by its place, its reading text and its label, and
//! the same passage found again in a revised tour.
use std::sync::LazyLock;

use regex::Regex;

use super::dom::{self, Dom, Node, NodeId};
use super::drawing::{Drawing, get};
use super::element::{label, short};
use crate::protocol::{CommentAnchor, TourTarget, TourTargetRequest};

/// Blocks whose content is code or a drawing, not reading text: they take a thread as a whole.
const OPAQUE: [&str; 4] = ["diffle-diff", "diffle-code", "diffle-tree", "diffle-diagram"];
/// Elements a thread may sit on as a whole, besides a diagram's boxes and labels.
const BLOCKS: [&str; 8] = [
    "diffle-card",
    "diffle-diff",
    "diffle-walk",
    "diffle-code",
    "diffle-tree",
    "diffle-callout",
    "diffle-diagram",
    "table",
];

/// A tour as threads find their place in it.
pub struct TourIndex {
    entries: Vec<Entry>,
}

struct Entry {
    node: Vec<i64>,
    step: Option<i64>,
    section: String,
    element: String,
    tag: String,
    /// Whitespace-free, as selections match it; none for an element without reading text.
    reading: Option<String>,
    /// Some for an element a thread may sit on as a whole.
    label: Option<String>,
}

impl TourIndex {
    pub fn read(html: &str) -> Self {
        let dom = dom::parse(html);
        let mut walk = Walk { dom: &dom, entries: Vec::new(), step: None, section: String::new() };
        walk.children(dom.section("body"), &[], "");
        Self { entries: walk.entries }
    }

    /// The anchor a new thread on `node` gets, or why it cannot sit there.
    pub fn place(&self, node: &[i64], target: &TourTargetRequest) -> Result<CommentAnchor, String> {
        let entry = self.entries.iter().find(|e| e.node == node).ok_or("no such element in the tour")?;
        let target = match target {
            TourTargetRequest::Element => {
                let label =
                    entry.label.clone().ok_or_else(|| format!("{} takes no comment as a whole", entry.element))?;
                TourTarget::Element { label }
            }
            TourTargetRequest::Text { quoted, occurrence } => {
                let found = entry.reading.as_deref().map_or(0, |text| matches(text, quoted));
                if *occurrence < 0 || *occurrence >= found as i64 {
                    return Err(format!("\"{}\" is not in {}", short(quoted), entry.element));
                }
                TourTarget::Text { quoted: collapse(quoted), occurrence: *occurrence }
            }
        };
        Ok(entry.anchor(target))
    }

    /// `anchor`'s passage in this tour, or none when it is gone: the same text in the innermost
    /// element holding it, or an element of the same kind with the same label, preferring the
    /// element at the old place, then the old section.
    pub fn relocate(&self, node: &[i64], section: &str, element: &str, target: &TourTarget) -> Option<CommentAnchor> {
        let rank = |e: &&Entry| (e.node != node, e.section != section);
        match target {
            TourTarget::Text { quoted, occurrence } => {
                let holding =
                    self.entries.iter().filter(|e| e.reading.as_deref().is_some_and(|t| matches(t, quoted) > 0));
                let entry = holding.min_by_key(|e| (rank(e), e.reading.as_ref().map_or(0, String::len)))?;
                let found = matches(entry.reading.as_deref().unwrap_or_default(), quoted) as i64;
                let target = TourTarget::Text { quoted: quoted.clone(), occurrence: (*occurrence).min(found - 1) };
                Some(entry.anchor(target))
            }
            TourTarget::Element { label } => {
                let tag = tag_in(element);
                let same = |e: &&Entry| {
                    e.tag == tag
                        && e.label.as_deref() == Some(label.as_str())
                        && (!label.is_empty() || e.section == section)
                };
                let entry = self.entries.iter().filter(same).min_by_key(rank)?;
                Some(entry.anchor(TourTarget::Element { label: label.clone() }))
            }
        }
    }
}

impl Entry {
    fn anchor(&self, target: TourTarget) -> CommentAnchor {
        CommentAnchor::Tour {
            node: self.node.clone(),
            step: self.step,
            section: self.section.clone(),
            element: self.element.clone(),
            target,
        }
    }
}

/// The tag an anchor's `element` ends with, as `Walk` names it.
fn tag_in(element: &str) -> &str {
    let last = element.rsplit(" > ").next().unwrap_or_default();
    last.trim_start_matches('<').split([' ', '>']).next().unwrap_or_default()
}

static ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#" ([a-z][a-z-]*)="([^"]*)""#).unwrap());

/// How the prompt names an anchor's `element`: its kind and the one handle an agent can search its
/// document for, never its geometry or the text the quote already shows. `text` for a selection in it.
pub fn spoken(element: &str, text: bool) -> String {
    let segments: Vec<&str> = element.split(" > ").collect();
    let last = segments.last().copied().unwrap_or_default();
    let of = |segment: &str, key: &str| {
        ATTR.captures_iter(segment).find(|c| &c[1] == key).map(|c| c[2].to_owned()).unwrap_or_default()
    };
    let attr = |key: &str| of(last, key);
    let card = segments.iter().find_map(|s| s.strip_prefix("diffle-card#"));
    let walk = segments.iter().find(|s| s.starts_with("diffle-walk "));
    let name = match tag_in(element) {
        "diffle-card" => format!("the card #{}", attr("id")),
        "diffle-diff" => format!("the diff of {}:{}", attr("path"), attr("lines")),
        "diffle-walk" => format!("the walk of {}:{}", attr("path"), attr("lines")),
        "diffle-note" => format!("the note \"{}\"", attr("title")),
        "diffle-code" if !attr("path").is_empty() => format!("the code of {}:{}", attr("path"), attr("line")),
        "diffle-code" => "a code block".into(),
        "diffle-tree" => "the file tree".into(),
        "diffle-callout" => format!("a {} callout", attr("kind")),
        "diffle-diagram" => "a diagram".into(),
        "rect" => "a box in the diagram".into(),
        "text" => "a label in the diagram".into(),
        tag => format!("a <{tag}>"),
    };
    let within = match (card, walk) {
        (Some(id), _) if tag_in(element) != "diffle-card" => format!(" in the card #{id}"),
        (_, Some(walk)) if tag_in(element) != "diffle-walk" => {
            format!(" in the walk of {}:{}", of(walk, "path"), of(walk, "lines"))
        }
        _ if tag_in(element) == "diffle-note" && segments.contains(&"diffle-diagram") => " in the diagram".into(),
        _ => String::new(),
    };
    format!("{} {name}{within}", if text { "in" } else { "on" })
}

struct Walk<'a> {
    dom: &'a Dom,
    entries: Vec<Entry>,
    step: Option<i64>,
    section: String,
}

impl Walk<'_> {
    /// The elements under `parent`, each at `node` plus its place, named after `context`.
    fn children(&mut self, parent: NodeId, node: &[i64], context: &str) {
        let elements = self.dom.children(parent).iter().filter(|&&c| matches!(self.dom.node(c), Node::Element { .. }));
        for (i, &child) in elements.enumerate() {
            let mut at = node.to_vec();
            at.push(i as i64);
            self.visit(child, at, context);
        }
    }

    fn visit(&mut self, id: NodeId, node: Vec<i64>, context: &str) {
        let Node::Element { name, attrs } = self.dom.node(id) else { return };
        let tag = name.local.to_string();
        if node.len() == 1 && tag == "h2" {
            self.step = Some(self.step.unwrap_or(0) + 1);
            self.section = collapse(&reading(self.dom, id));
        }
        let element = format!("{context}{}", label(&tag, attrs));
        if tag == "diffle-diagram" {
            self.diagram(id, &node, element);
            return;
        }
        let text = (!OPAQUE.contains(&tag.as_str())).then(|| squash(&reading(self.dom, id))).filter(|t| !t.is_empty());
        let block = BLOCKS.contains(&tag.as_str()).then(|| self.label(id, &tag, attrs));
        self.push(&node, element, &tag, text, block);
        let inner = match tag.as_str() {
            "diffle-card" => format!("{context}diffle-card#{} > ", get(attrs, "id")),
            "diffle-walk" => format!("{context}{} > ", label(&tag, attrs)),
            _ => context.to_owned(),
        };
        if !OPAQUE.contains(&tag.as_str()) {
            self.children(id, &node, &inner);
        }
    }

    /// A diagram, and each box and label in it, which take threads as a whole.
    fn diagram(&mut self, id: NodeId, node: &[i64], element: String) {
        self.push(node, element, "diffle-diagram", None, Some(String::new()));
        let elements: Vec<NodeId> = self
            .dom
            .children(id)
            .iter()
            .copied()
            .filter(|&c| matches!(self.dom.node(c), Node::Element { .. }))
            .collect();
        // Its notes, when it steps, read as prose.
        let is = |c: NodeId, tag: &str| matches!(self.dom.node(c), Node::Element { name, .. } if &*name.local == tag);
        for (i, &child) in elements.iter().enumerate() {
            if is(child, "diffle-note") {
                self.visit(child, [node, &[i as i64]].concat(), "diffle-diagram > ");
            }
        }
        let Some(at) = elements.iter().position(|&c| is(c, "svg")) else { return };
        let svg = elements[at];
        let drawing = Drawing::read(self.dom, svg, "");
        let mut shapes = Vec::new();
        self.places(svg, &[node, &[at as i64]].concat(), &mut shapes);
        for (shape, at) in shapes {
            let Node::Element { name, attrs } = self.dom.node(shape) else { continue };
            let label = match &*name.local {
                "rect" => {
                    let inside = drawing.labels.iter().filter(|l| drawing.box_of(l).is_some_and(|r| r.node == shape));
                    inside.map(|l| collapse(&reading(self.dom, l.node))).collect::<Vec<_>>().join(" ")
                }
                "text" => collapse(&reading(self.dom, shape)),
                _ => continue,
            };
            let element = format!("diffle-diagram > {}", self::label(&name.local, attrs));
            self.push(&at, element, &name.local, None, Some(label));
        }
    }

    /// Every element under `parent` with its place.
    fn places(&self, parent: NodeId, node: &[i64], out: &mut Vec<(NodeId, Vec<i64>)>) {
        let elements = self.dom.children(parent).iter().filter(|&&c| matches!(self.dom.node(c), Node::Element { .. }));
        for (i, &child) in elements.enumerate() {
            let at = [node, &[i as i64]].concat();
            out.push((child, at.clone()));
            self.places(child, &at, out);
        }
    }

    fn push(&mut self, node: &[i64], element: String, tag: &str, reading: Option<String>, label: Option<String>) {
        if reading.is_none() && label.is_none() {
            return;
        }
        let (step, section) = (self.step, self.section.clone());
        self.entries.push(Entry { node: node.to_vec(), step, section, element, tag: tag.into(), reading, label });
    }

    /// What finds a block again: its title, its file and lines, or the start of its text.
    fn label(&self, id: NodeId, tag: &str, attrs: &[(String, String)]) -> String {
        let attr = |key: &str| get(attrs, key).to_owned();
        match tag {
            "diffle-card" => attr("title"),
            "diffle-diff" | "diffle-walk" => format!("{} {}", attr("path"), attr("lines")),
            "diffle-tree" => short(&attr("paths")),
            "diffle-code" if !attr("title").is_empty() => attr("title"),
            "diffle-code" if !attr("path").is_empty() => format!("{}:{}", attr("path"), attr("line")),
            "diffle-code" => short(self.dom.text(id).trim()),
            _ => short(&collapse(&reading(self.dom, id))),
        }
    }
}

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
                let titled = matches!(tag, "diffle-card" | "diffle-note");
                if titled { format!("{} {inner}", get(attrs, "title")) } else { inner }
            }
        },
        _ => String::new(),
    }
}

/// `text` with each whitespace run one space, trimmed.
fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `text` without whitespace: a selection and the element's text agree on everything else.
fn squash(text: &str) -> String {
    text.split_whitespace().collect()
}

/// How many times `quoted` occurs in `reading`, whitespace ignored, overlaps included.
fn matches(reading: &str, quoted: &str) -> usize {
    let quoted = squash(quoted);
    if quoted.is_empty() {
        return 0;
    }
    (0..reading.len()).filter(|&i| reading.is_char_boundary(i) && reading[i..].starts_with(&quoted)).count()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    const TOUR: &str = r#"<h1>Retries</h1><p>Why it retries.</p>
<h2>The loop</h2><p>It calls <diffle-symbol path="a.rs" line="3" name="fetch"></diffle-symbol> again, and again.</p>
<diffle-card id="loop" title="The loop"><p>Backs off.</p><diffle-diff path="a.rs" lines="1-4"></diffle-diff></diffle-card>
<h2>Wiring</h2><diffle-diagram><svg viewBox="0 0 200 60"><rect x="8" y="8" width="96" height="40"></rect><text x="56" y="28">Session</text></svg></diffle-diagram>"#;

    fn text(quoted: &str, occurrence: i64) -> TourTargetRequest {
        TourTargetRequest::Text { quoted: quoted.into(), occurrence }
    }

    fn json(anchor: &CommentAnchor) -> Value {
        serde_json::to_value(anchor).unwrap()
    }

    fn relocate(tour: &TourIndex, anchor: &CommentAnchor) -> Option<Value> {
        let CommentAnchor::Tour { node, section, element, target, .. } = anchor else { panic!("a tour anchor") };
        tour.relocate(node, section, element, target).as_ref().map(json)
    }

    #[test]
    fn places_a_selection_in_reading_text_whitespace_ignored() {
        let tour = TourIndex::read(TOUR);

        let anchor = tour.place(&[3], &text("calls fetch\n again", 0)).unwrap();

        assert_eq!(
            json(&anchor),
            json!({"kind": "tour", "node": [3], "step": 1, "section": "The loop", "element": "<p>",
                   "target": {"on": "text", "quoted": "calls fetch again", "occurrence": 0}})
        );
        assert!(tour.place(&[3], &text("again", 1)).is_ok());
        assert_eq!(tour.place(&[3], &text("again", 2)).unwrap_err(), "\"again\" is not in <p>");
    }

    #[test]
    fn labels_blocks_and_diagram_boxes() {
        let tour = TourIndex::read(TOUR);
        let whole = |node: &[i64]| tour.place(node, &TourTargetRequest::Element).map(|a| json(&a));

        assert_eq!(whole(&[4]).unwrap()["target"], json!({"on": "element", "label": "The loop"}));
        let diff = whole(&[4, 1]).unwrap();
        assert_eq!(diff["element"], r#"diffle-card#loop > diffle-diff path="a.rs" lines="1-4""#);
        assert_eq!(diff["target"]["label"], "a.rs 1-4");
        let rect = whole(&[6, 0, 0]).unwrap();
        assert_eq!((&rect["step"], &rect["target"]["label"]), (&json!(2), &json!("Session")));
        assert_eq!(whole(&[3]).unwrap_err(), "<p> takes no comment as a whole");
    }

    #[test]
    fn a_walk_takes_a_thread_as_a_whole_and_its_notes_take_selections() {
        let walk = r#"<diffle-walk path="a.rs" lines="1-4"><diffle-note lines="1-2" title="Setup">Opens it.</diffle-note>
<diffle-note lines="3-4" title="Retry">Calls <diffle-symbol path="a.rs" line="3" name="fetch"></diffle-symbol> again.</diffle-note></diffle-walk>"#;
        let tour = TourIndex::read(&format!("{TOUR}{walk}"));

        let whole = json(&tour.place(&[7], &TourTargetRequest::Element).unwrap());
        let note = json(&tour.place(&[7, 1], &text("Retry Calls fetch", 0)).unwrap());

        assert_eq!(whole["target"], json!({"on": "element", "label": "a.rs 1-4"}));
        assert_eq!(note["element"], r#"diffle-walk path="a.rs" lines="1-4" > diffle-note lines="3-4" title="Retry""#);
    }

    #[test]
    fn names_an_element_by_its_kind_and_handle() {
        assert_eq!(spoken(r#"diffle-card id="entry" title="The loader""#, false), "on the card #entry");
        assert_eq!(spoken("diffle-card#entry > <p>", true), "in a <p> in the card #entry");
        assert_eq!(
            spoken(r#"diffle-card#entry > diffle-diff path="src/app.py" lines="12-20""#, false),
            "on the diff of src/app.py:12-20 in the card #entry"
        );
        assert_eq!(
            spoken(r#"diffle-diagram > <rect x="8" y="8" width="96" height="40">"#, false),
            "on a box in the diagram"
        );
        assert_eq!(
            spoken(r#"diffle-walk path="a.rs" lines="1-9" > diffle-note lines="2-4" title="Retry""#, true),
            "in the note \"Retry\" in the walk of a.rs:1-9"
        );
    }

    #[test]
    fn follows_a_passage_into_a_revised_tour_or_loses_it() {
        let old = TourIndex::read(TOUR);
        let passage = old.place(&[3], &text("calls fetch", 0)).unwrap();
        let rect = old.place(&[6, 0, 0], &TourTargetRequest::Element).unwrap();
        // A section and a paragraph added before them, the passages themselves untouched.
        let revised = TOUR.replace("<h2>The loop</h2>", "<h2>Setup</h2><p>New.</p><h2>The loop</h2><p>Lead.</p>");
        let new = TourIndex::read(&revised);

        let moved = relocate(&new, &passage).unwrap();
        assert_eq!((&moved["node"], &moved["step"]), (&json!([6]), &json!(2)));
        assert_eq!(relocate(&new, &rect).unwrap()["node"], json!([9, 0, 0]));
        assert_eq!(relocate(&TourIndex::read(&TOUR.replace("calls", "invokes")), &passage), None);
        assert_eq!(relocate(&TourIndex::read(&TOUR.replace(">Session<", ">Store<")), &rect), None);
    }
}
