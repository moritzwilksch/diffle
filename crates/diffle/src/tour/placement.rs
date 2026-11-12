//! Where each element of a tour may sit, and what a block must hold. A tour is an article: headings,
//! prose and blocks at its top level, inline primitives inside prose, and no block inside a line of
//! text.
use super::dom::{Dom, Node, NodeId};

/// What directly holds an element: some elements sit in one of these alone.
#[derive(Clone, Copy, PartialEq)]
pub enum Parent {
    /// The article, where `h1` titles it and `h2` and `h3` start sections.
    Top,
    /// Anything else: a paragraph, a list, a card, a callout, a row's column.
    Flow,
    /// A block of parts (a checklist, a tree), where its parts sit.
    Parts,
    /// A `diffle-tabs`, where its tabs sit.
    Tabs,
    /// A `<details>`, where its `<summary>` sits.
    Details,
}

/// The most restrictive block an element sits inside, in order: a tab refuses tabs in it, a card
/// also cards and other big blocks, a callout also callouts. Every rule below refuses from some
/// level up, so the strictest enclosing block decides alone.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Inside {
    Article,
    Tab,
    Card,
    Callout,
}

/// Where an element sits, deciding what it may hold.
#[derive(Clone, Copy, PartialEq)]
pub struct Place {
    pub parent: Parent,
    pub inside: Inside,
    /// Inside a line of text (a paragraph, a heading, a link, code, a checklist item), where no
    /// block fits. Apart from `inside`: text sits in cards and callouts alike.
    pub in_text: bool,
}

impl Place {
    pub const TOP: Self = Self { parent: Parent::Top, inside: Inside::Article, in_text: false };

    /// The place of what a plain `tag` here holds.
    pub fn within(self, tag: &str) -> Self {
        let text = matches!(tag, "p" | "h1" | "h2" | "h3" | "h4" | "a" | "strong" | "em" | "code" | "pre" | "summary");
        let parent = if tag == "details" { Parent::Details } else { Parent::Flow };
        Self { parent, in_text: self.in_text || text, ..self }
    }

    /// The place of what a `diffle-row` here holds: its columns.
    pub fn in_row(self) -> Self {
        Self { parent: Parent::Flow, ..self }
    }
}

/// What a `diffle-*` tag is, deciding where it may sit.
#[derive(Clone, Copy, PartialEq)]
pub enum Rule {
    Row,
    /// `diffle-code`: a block holding its code as text.
    Code,
    Card,
    Callout,
    /// `diffle-tabs`: a block holding its tabs.
    Tabs,
    /// `diffle-tab`: a pane of tabs, holding what a card holds.
    Tab,
    /// `diffle-check`: a block holding its items.
    Check,
    /// `diffle-item`: a question of a checklist, holding a line of text.
    Item,
    Diagram,
    Jump,
    /// `diffle-diff`: a block holding nothing.
    Block,
    /// `diffle-tree`: a block holding notes on some of its files.
    Tree,
    /// `diffle-file`: a note on a file of a tree, holding a few words.
    File,
    /// `diffle-symbol`: a word of the prose, holding nothing.
    Symbol,
    /// `diffle-icon`: a mark in a line of text, holding nothing.
    Icon,
}

impl Rule {
    pub fn of(tag: &str) -> Option<Self> {
        Some(match tag {
            "diffle-row" => Self::Row,
            "diffle-code" => Self::Code,
            "diffle-card" => Self::Card,
            "diffle-callout" => Self::Callout,
            "diffle-tabs" => Self::Tabs,
            "diffle-tab" => Self::Tab,
            "diffle-check" => Self::Check,
            "diffle-item" => Self::Item,
            "diffle-diagram" => Self::Diagram,
            "diffle-jump" => Self::Jump,
            "diffle-diff" => Self::Block,
            "diffle-tree" => Self::Tree,
            "diffle-file" => Self::File,
            "diffle-symbol" => Self::Symbol,
            "diffle-icon" => Self::Icon,
            _ => return None,
        })
    }

    pub fn fits(self, place: Place) -> bool {
        match self {
            Self::Row => place.parent == Parent::Top,
            Self::Card | Self::Check => !place.in_text && place.inside < Inside::Card,
            Self::Item | Self::File => place.parent == Parent::Parts,
            Self::Tabs => !place.in_text && place.inside == Inside::Article,
            Self::Tab => place.parent == Parent::Tabs,
            Self::Callout => !place.in_text && place.inside < Inside::Callout,
            Self::Code | Self::Diagram | Self::Block | Self::Tree => !place.in_text,
            Self::Jump | Self::Symbol | Self::Icon => place.parent != Parent::Top,
        }
    }

    pub fn home(self) -> &'static str {
        match self {
            Self::Row => "at the top level, between paragraphs",
            Self::Card => "between paragraphs, outside other cards and callouts",
            Self::Check => "between paragraphs, outside cards and callouts",
            Self::Item => "directly inside a diffle-check",
            Self::File => "directly inside a diffle-tree",
            Self::Tabs => "between paragraphs, outside cards, callouts and other tabs",
            Self::Tab => "directly inside a diffle-tabs",
            Self::Callout => "between paragraphs, outside other callouts",
            Self::Code | Self::Diagram | Self::Block | Self::Tree => {
                "between paragraphs: it is a block, not part of a line of text"
            }
            Self::Jump | Self::Symbol | Self::Icon => "inside a paragraph, a list item or other text",
        }
    }
}

impl Rule {
    /// The place of what an element of this rule at `place` holds.
    pub fn inner(self, place: Place) -> Place {
        let flow = Place { parent: Parent::Flow, ..place };
        let enclosed = |inside: Inside| Place { inside: place.inside.max(inside), ..flow };
        match self {
            Self::Card => enclosed(Inside::Card),
            Self::Callout => enclosed(Inside::Callout),
            Self::Tab => enclosed(Inside::Tab),
            Self::Item | Self::File => Place { in_text: true, ..flow },
            Self::Check | Self::Tree => Place { parent: Parent::Parts, ..flow },
            Self::Tabs => Place { parent: Parent::Tabs, ..flow },
            _ => flow,
        }
    }
}

/// Why a plain `tag` cannot sit at `place`, if it cannot.
pub fn misplaced(tag: &str, place: Place) -> Option<&'static str> {
    match tag {
        "h1" if place.parent != Parent::Top => Some("<h1> sits at the top level, where it titles the tour"),
        "h2" | "h3" if place.parent != Parent::Top => {
            Some("a heading sits at the top level, where it starts a section")
        }
        "details" if place.in_text => Some("<details> is a block: it sits between paragraphs"),
        "summary" if place.parent != Parent::Details => {
            Some("<summary> sits first in a <details>, saying what opening it shows")
        }
        _ => None,
    }
}

/// Whether `tag` can be a column of a `diffle-row`: a block, or short prose.
pub fn is_column(tag: &str) -> bool {
    matches!(
        tag,
        "diffle-card"
            | "diffle-code"
            | "diffle-diff"
            | "diffle-diagram"
            | "diffle-tree"
            | "diffle-callout"
            | "table"
            | "div"
            | "p"
            | "ul"
            | "ol"
    )
}

/// Whether a checklist item may hold `tag`: inline prose and the inline primitives.
pub fn fits_sentence(tag: &str) -> bool {
    tag.starts_with("diffle-") || matches!(tag, "code" | "strong" | "em" | "a")
}

/// Whether the `<details>` at `node` holds one `<summary>`, as its first element.
pub fn opens_with_summary(dom: &Dom, node: NodeId) -> bool {
    let is_summary = |&c: &NodeId| matches!(dom.node(c), Node::Element { name, .. } if &*name.local == "summary");
    let elements: Vec<NodeId> =
        dom.children(node).iter().copied().filter(|&c| matches!(dom.node(c), Node::Element { .. })).collect();
    elements.first().is_some_and(is_summary) && elements.iter().filter(|c| is_summary(c)).count() == 1
}

/// Whether a `diffle-diff` sits anywhere inside `node`.
pub fn holds_diff(dom: &Dom, node: NodeId) -> bool {
    dom.children(node).iter().any(|&c| match dom.node(c) {
        Node::Element { name, .. } => &*name.local == "diffle-diff" || holds_diff(dom, c),
        _ => false,
    })
}
