//! Where a thread sits in a tour: each element by its place, its reading text and its label, and
//! the same passage found again in a revised tour.
use super::dom::{self, Dom, Node, NodeId};
use super::drawing::Drawing;
use super::element::{attr, label, short};
use super::reading::{collapse, is_opaque, matches, reading, squash};
use crate::protocol::{
    CommentAnchor, TourCheckItem, TourCommentTag, TourPart, TourTarget, TourTargetRequest, TourWholeTag,
};

/// A tour as threads find their place in it.
pub struct TourIndex {
    entries: Vec<Entry>,
}

struct Entry {
    node: Vec<i64>,
    step: Option<i64>,
    section: String,
    /** How refusals name it, as a refused push does. */
    element: String,
    part: TourPart,
    within: Option<TourPart>,
    /// Whitespace-free, as selections match it; none for an element without reading text.
    reading: Option<String>,
    /// Some for an element a thread may sit on as a whole.
    label: Option<String>,
}

impl TourIndex {
    pub fn read(html: &str) -> Self {
        let dom = dom::parse(html);
        let mut walk = Walk { dom: &dom, entries: Vec::new(), step: None, section: String::new() };
        walk.children(dom.section("body"), &[], "", None);
        Self { entries: walk.entries }
    }

    /// The questions of the tour's checklists, in document order: what a tick names an item by.
    pub fn questions(&self) -> Vec<String> {
        self.checks(&[]).into_iter().map(|item| item.question).collect()
    }

    /// The items of the tour's checklists in document order, each ticked when `ticked` holds its question.
    pub fn checks(&self, ticked: &[String]) -> Vec<TourCheckItem> {
        let items = self.entries.iter().filter(|e| e.part.tag == TourCommentTag::DiffleItem);
        let item = |e: &Entry| {
            let question = e.label.clone().unwrap_or_default();
            let ticked = ticked.contains(&question);
            TourCheckItem {
                node: e.node.clone(),
                step: e.step,
                section: e.section.clone(),
                question,
                ticked,
                thread: None,
            }
        };
        items.map(item).collect()
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
    /// element holding it, or an element of the same `tag` with the same label, preferring the
    /// element at the old place, then the old section.
    pub fn relocate(
        &self,
        node: &[i64],
        section: &str,
        tag: TourCommentTag,
        target: &TourTarget,
    ) -> Option<CommentAnchor> {
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
                let same = |e: &&Entry| {
                    e.part.tag == tag
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
            element: self.part.clone(),
            within: self.within.clone(),
            target,
        }
    }
}

struct Walk<'a> {
    dom: &'a Dom,
    entries: Vec<Entry>,
    step: Option<i64>,
    section: String,
}

impl Walk<'_> {
    /// The elements under `parent`, each at `node` plus its place, named after `context`, inside
    /// the card, tab or walk `within`.
    fn children(&mut self, parent: NodeId, node: &[i64], context: &str, within: Option<&TourPart>) {
        let elements = self.dom.children(parent).iter().filter(|&&c| matches!(self.dom.node(c), Node::Element { .. }));
        for (i, &child) in elements.enumerate() {
            let mut at = node.to_vec();
            at.push(i as i64);
            self.visit(child, at, context, within);
        }
    }

    fn visit(&mut self, id: NodeId, node: Vec<i64>, context: &str, within: Option<&TourPart>) {
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
        let Some(part) = part(&tag, attrs) else {
            // No tag a thread can name; a checked tour holds none outside a diagram.
            return self.children(id, &node, context, within);
        };
        let text = (!is_opaque(&tag)).then(|| squash(&reading(self.dom, id))).filter(|t| !t.is_empty());
        let block = tag.parse::<TourWholeTag>().is_ok().then(|| self.label(id, &tag, attrs));
        self.push(&node, element, part.clone(), within.cloned(), text, block);
        let inner = match tag.as_str() {
            "diffle-card" => format!("{context}diffle-card#{} > ", attr(attrs, "id").unwrap_or_default()),
            "diffle-walk" | "diffle-trace" | "diffle-tabs" | "diffle-tab" => {
                format!("{context}{} > ", label(&tag, attrs))
            }
            _ => context.to_owned(),
        };
        let holder = matches!(tag.as_str(), "diffle-card" | "diffle-tab" | "diffle-walk");
        if !is_opaque(&tag) {
            self.children(id, &node, &inner, if holder { Some(&part) } else { within });
        }
    }

    /// A diagram, and each box and label in it, which take threads as a whole.
    fn diagram(&mut self, id: NodeId, node: &[i64], element: String) {
        let diagram = TourPart { tag: TourCommentTag::DiffleDiagram, handle: None };
        self.push(node, element, diagram.clone(), None, None, Some(String::new()));
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
                self.visit(child, [node, &[i as i64]].concat(), "diffle-diagram > ", Some(&diagram));
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
            // A box or a label names its diagram itself.
            let Some(part) = part(&name.local, attrs) else { continue };
            self.push(&at, element, part, None, None, Some(label));
        }
    }

    /// What finds a set of tabs again: their titles.
    fn titles(&self, id: NodeId) -> String {
        let titles = self.dom.children(id).iter().filter_map(|&c| match self.dom.node(c) {
            Node::Element { name, attrs } if &*name.local == "diffle-tab" => {
                Some(attr(attrs, "title").unwrap_or_default())
            }
            _ => None,
        });
        titles.collect::<Vec<_>>().join(" / ")
    }

    /// What finds a trace again: its first stop's place.
    fn first_stop(&self, id: NodeId) -> String {
        let stop = self.dom.children(id).iter().find_map(|&c| match self.dom.node(c) {
            Node::Element { name, attrs } if &*name.local == "diffle-stop" => Some(attrs),
            _ => None,
        });
        stop.map_or_else(String::new, |attrs| {
            format!("{}:{}", attr(attrs, "path").unwrap_or_default(), attr(attrs, "line").unwrap_or_default())
        })
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

    fn push(
        &mut self,
        node: &[i64],
        element: String,
        part: TourPart,
        within: Option<TourPart>,
        reading: Option<String>,
        label: Option<String>,
    ) {
        if reading.is_none() && label.is_none() {
            return;
        }
        let (step, section, node) = (self.step, self.section.clone(), node.to_vec());
        self.entries.push(Entry { node, step, section, element, part, within, reading, label });
    }

    /// What finds a block again: its title, its file and lines, or the start of its text.
    fn label(&self, id: NodeId, tag: &str, attrs: &[(String, String)]) -> String {
        let value = |key: &str| attr(attrs, key).unwrap_or_default().to_owned();
        match tag {
            "diffle-card" => value("title"),
            "diffle-diff" | "diffle-walk" => format!("{} {}", value("path"), value("lines")),
            "diffle-trace" => self.first_stop(id),
            "diffle-tabs" => self.titles(id),
            // An item's whole question: ticks and answers find it again by it.
            "diffle-item" => collapse(&reading(self.dom, id)),
            "diffle-tree" => value("title"),
            "diffle-code" if !value("title").is_empty() => value("title"),
            "diffle-code" if !value("path").is_empty() => format!("{}:{}", value("path"), value("line")),
            "diffle-code" => short(self.dom.text(id).trim()),
            _ => short(&collapse(&reading(self.dom, id))),
        }
    }
}

/// The element `tag` with `attrs` by its handle, in full: what an agent searches its document for;
/// none for a tag no thread can name.
fn part(tag: &str, attrs: &[(String, String)]) -> Option<TourPart> {
    let value = |key: &str| attr(attrs, key).filter(|v| !v.is_empty());
    let at = |line: &str| value("path").map(|path| format!("{path}:{}", attr(attrs, line).unwrap_or_default()));
    let handle = match tag {
        "diffle-card" => value("id").map(str::to_owned),
        "diffle-diff" | "diffle-walk" => at("lines"),
        "diffle-stop" | "diffle-code" => at("line"),
        "diffle-note" | "diffle-tab" | "diffle-tree" => value("title").map(str::to_owned),
        "diffle-callout" => value("kind").map(str::to_owned),
        _ => None,
    };
    Some(TourPart { tag: tag.parse().ok()?, handle })
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
        tour.relocate(node, section, element.tag, target).as_ref().map(json)
    }

    #[test]
    fn places_a_selection_in_reading_text_whitespace_ignored() {
        let tour = TourIndex::read(TOUR);

        let anchor = tour.place(&[3], &text("calls fetch\n again", 0)).unwrap();

        assert_eq!(
            json(&anchor),
            json!({"kind": "tour", "node": [3], "step": 1, "section": "The loop", "element": {"tag": "p"},
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
        assert_eq!(
            (&diff["element"], &diff["within"]),
            (&json!({"tag": "diffle-diff", "handle": "a.rs:1-4"}), &json!({"tag": "diffle-card", "handle": "loop"}))
        );
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
        assert_eq!(
            (&note["element"], &note["within"]),
            (&json!({"tag": "diffle-note", "handle": "Retry"}), &json!({"tag": "diffle-walk", "handle": "a.rs:1-4"}))
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
