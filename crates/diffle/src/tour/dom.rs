//! A tour document parsed as a browser's `DOMParser` parses it: html5ever's tree construction into
//! an arena, so the validator sees the tree the client will render.
use std::borrow::Cow;
use std::cell::RefCell;

use html5ever::interface::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::{Attribute, LocalName, QualName, local_name, ns};

pub type NodeId = usize;

pub enum Node {
    /// The document, or a `template`'s contents.
    Root,
    Element {
        name: QualName,
        /// In source order, names lowercased.
        attrs: Vec<(String, String)>,
    },
    Text(String),
    /// A comment, a doctype or a processing instruction: nothing the tour shows.
    Ignored,
}

pub struct Dom {
    nodes: Vec<(Node, Vec<NodeId>)>,
}

/// Parses `html` as a whole document; never fails, as a browser never does.
pub fn parse(html: &str) -> Dom {
    html5ever::parse_document(Sink::default(), Default::default()).one(html)
}

impl Dom {
    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id].0
    }

    pub fn children(&self, id: NodeId) -> &[NodeId] {
        &self.nodes[id].1
    }

    /// The element `<html>` holds by this local name: `head` or `body`, which the parser always creates.
    pub fn section(&self, local: &str) -> NodeId {
        let html = self.children(0).iter().copied().find(|&id| self.is(id, "html")).expect("an html element");
        self.children(html).iter().copied().find(|&id| self.is(id, local)).expect("head and body")
    }

    /// The plain text under `id`, as a heading or a code block reads.
    pub fn text(&self, id: NodeId) -> String {
        let text = |&c: &NodeId| match self.node(c) {
            Node::Text(t) => t.to_string(),
            Node::Element { .. } => self.text(c),
            _ => String::new(),
        };
        self.children(id).iter().map(text).collect()
    }

    /// Whether `id` is an HTML element named `local`.
    fn is(&self, id: NodeId, local: &str) -> bool {
        matches!(self.node(id), Node::Element { name, .. } if name.ns == ns!(html) && &*name.local == local)
    }
}

/// A node while the tree is built: what it is, what it holds, and what holds it.
type Slot = (Node, Vec<NodeId>, Option<NodeId>);

#[derive(Default)]
struct Sink {
    nodes: RefCell<Vec<Slot>>,
}

impl Sink {
    fn add(&self, node: Node) -> NodeId {
        let mut nodes = self.nodes.borrow_mut();
        nodes.push((node, Vec::new(), None));
        nodes.len() - 1
    }

    /// Inserts `child` into `parent` at `at`, merging text into a neighbouring text node as the DOM does.
    fn insert(&self, parent: NodeId, at: usize, child: NodeOrText<NodeId>) {
        let id = match child {
            NodeOrText::AppendNode(id) => id,
            NodeOrText::AppendText(text) => {
                let mut nodes = self.nodes.borrow_mut();
                let before = at.checked_sub(1).map(|i| nodes[parent].1[i]);
                if let Some(prev) = before
                    && let Node::Text(existing) = &mut nodes[prev].0
                {
                    existing.push_str(&text);
                    return;
                }
                drop(nodes);
                self.add(Node::Text(text.to_string()))
            }
        };
        let mut nodes = self.nodes.borrow_mut();
        nodes[parent].1.insert(at, id);
        nodes[id].2 = Some(parent);
    }

    fn detach(&self, id: NodeId) -> Option<(NodeId, usize)> {
        let mut nodes = self.nodes.borrow_mut();
        let parent = nodes[id].2.take()?;
        let at = nodes[parent].1.iter().position(|&c| c == id)?;
        nodes[parent].1.remove(at);
        Some((parent, at))
    }
}

/// An element's name, as the tree builder asks for it.
#[derive(Debug)]
pub struct Name(QualName);

impl html5ever::interface::ElemName for Name {
    fn ns(&self) -> &html5ever::Namespace {
        &self.0.ns
    }

    fn local_name(&self) -> &LocalName {
        &self.0.local
    }
}

impl TreeSink for Sink {
    type Handle = NodeId;
    type Output = Dom;
    type ElemName<'a> = Name;

    fn finish(self) -> Dom {
        Dom { nodes: self.nodes.into_inner().into_iter().map(|(node, children, _)| (node, children)).collect() }
    }

    fn parse_error(&self, _: Cow<'static, str>) {}

    fn get_document(&self) -> NodeId {
        if self.nodes.borrow().is_empty() {
            self.add(Node::Root);
        }
        0
    }

    fn elem_name(&self, target: &NodeId) -> Name {
        match &self.nodes.borrow()[*target].0 {
            Node::Element { name, .. } => Name(name.clone()),
            _ => Name(QualName::new(None, ns!(), local_name!(""))),
        }
    }

    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> NodeId {
        let attrs = attrs.into_iter().map(|a| (a.name.local.to_string(), a.value.to_string())).collect();
        let id = self.add(Node::Element { name, attrs });
        if flags.template {
            // The contents live in a fragment of their own, which the validator never reaches.
            let contents = self.add(Node::Root);
            self.nodes.borrow_mut()[id].1.push(contents);
        }
        id
    }

    fn create_comment(&self, _: StrTendril) -> NodeId {
        self.add(Node::Ignored)
    }

    fn create_pi(&self, _: StrTendril, _: StrTendril) -> NodeId {
        self.add(Node::Ignored)
    }

    fn append(&self, parent: &NodeId, child: NodeOrText<NodeId>) {
        let at = self.nodes.borrow()[*parent].1.len();
        self.insert(*parent, at, child);
    }

    fn append_based_on_parent_node(&self, element: &NodeId, prev: &NodeId, child: NodeOrText<NodeId>) {
        if self.nodes.borrow()[*element].2.is_some() {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev, child);
        }
    }

    fn append_doctype_to_document(&self, _: StrTendril, _: StrTendril, _: StrTendril) {}

    fn get_template_contents(&self, target: &NodeId) -> NodeId {
        self.nodes.borrow()[*target].1[0]
    }

    fn same_node(&self, x: &NodeId, y: &NodeId) -> bool {
        x == y
    }

    fn set_quirks_mode(&self, _: QuirksMode) {}

    fn append_before_sibling(&self, sibling: &NodeId, child: NodeOrText<NodeId>) {
        let place = {
            let nodes = self.nodes.borrow();
            nodes[*sibling].2.map(|parent| (parent, nodes[parent].1.iter().position(|c| c == sibling).unwrap()))
        };
        if let Some((parent, at)) = place {
            if let NodeOrText::AppendNode(id) = &child {
                self.detach(*id);
            }
            self.insert(parent, at, child);
        }
    }

    fn add_attrs_if_missing(&self, target: &NodeId, attrs: Vec<Attribute>) {
        if let Node::Element { attrs: existing, .. } = &mut self.nodes.borrow_mut()[*target].0 {
            for a in attrs {
                let name = a.name.local.to_string();
                if !existing.iter().any(|(n, _)| *n == name) {
                    existing.push((name, a.value.to_string()));
                }
            }
        }
    }

    fn remove_from_parent(&self, target: &NodeId) {
        self.detach(*target);
    }

    fn reparent_children(&self, node: &NodeId, new_parent: &NodeId) {
        let children = std::mem::take(&mut self.nodes.borrow_mut()[*node].1);
        let mut nodes = self.nodes.borrow_mut();
        for &child in &children {
            nodes[child].2 = Some(*new_parent);
        }
        nodes[*new_parent].1.extend(children);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outline(dom: &Dom, id: NodeId) -> String {
        match dom.node(id) {
            Node::Element { name, .. } => {
                let inner: Vec<String> = dom.children(id).iter().map(|&c| outline(dom, c)).collect();
                format!("{}({})", name.local, inner.join(" "))
            }
            Node::Text(text) => format!("{text:?}"),
            _ => String::new(),
        }
    }

    #[test]
    fn builds_the_tree_a_browser_builds() {
        let dom = parse("<diffle-card id=a><p>one<ul><li>x</ul></diffle-card><diffle-edge from=a/>tail");
        let body = dom.section("body");
        // `<p>` closes before the list, and `/>` does not close a custom element.
        assert_eq!(outline(&dom, body), r#"body(diffle-card(p("one") ul(li("x"))) diffle-edge("tail"))"#);
    }

    #[test]
    fn keeps_head_content_apart() {
        let dom = parse("<style>p{}</style><p>a</p>");
        assert_eq!(outline(&dom, dom.section("head")), r#"head(style("p{}"))"#);
    }
}
