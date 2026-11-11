//! Where each element of a tour may sit. A tour is an article: headings, prose and blocks at its
//! top level, inline primitives inside prose, and no block inside a line of text.

/// Where an element sits, deciding what it may hold.
#[derive(Clone, Copy, PartialEq)]
pub struct Place {
    /// Directly in the article, where `h1` titles it and `h2` and `h3` start sections.
    pub top: bool,
    /// Inside a `diffle-card`.
    pub in_card: bool,
    /// Inside a `diffle-callout`.
    pub in_callout: bool,
    /// Inside a line of text (a paragraph, a heading, a link, code), where no block fits.
    pub in_text: bool,
    /// Directly in a block of parts (a walk, a trace, a diagram, a checklist, a tree), where they sit.
    pub in_parts: bool,
    /// Directly in a `diffle-tabs`, where its tabs sit.
    pub in_tabs: bool,
    /// Inside a `diffle-tab`'s pane.
    pub in_tab: bool,
    /// Directly in a `<details>`, where its `<summary>` sits.
    pub in_details: bool,
}

impl Place {
    pub const TOP: Self = Self {
        top: true,
        in_card: false,
        in_callout: false,
        in_text: false,
        in_parts: false,
        in_tabs: false,
        in_tab: false,
        in_details: false,
    };

    /// The place of what a plain `tag` here holds.
    pub fn within(self, tag: &str) -> Self {
        let text = matches!(tag, "p" | "h1" | "h2" | "h3" | "h4" | "a" | "strong" | "em" | "code" | "pre" | "summary");
        let in_details = tag == "details";
        Self { top: false, in_text: self.in_text || text, in_parts: false, in_tabs: false, in_details, ..self }
    }
}

/// What a `diffle-*` tag is, deciding where it may sit.
#[derive(Clone, Copy, PartialEq)]
pub enum Rule {
    Row,
    /// `diffle-code`: a block holding its code as text.
    Code,
    Card,
    /// `diffle-walk`: a block holding its notes.
    Walk,
    /// `diffle-note`: a step of a walk, holding a sentence or two.
    Note,
    /// `diffle-trace`: a block holding its stops.
    Trace,
    /// `diffle-stop`: a step of a trace, holding a sentence or two.
    Stop,
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
            "diffle-walk" => Self::Walk,
            "diffle-note" => Self::Note,
            "diffle-trace" => Self::Trace,
            "diffle-stop" => Self::Stop,
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
            Self::Row => place.top,
            Self::Card | Self::Walk | Self::Trace | Self::Check => {
                !place.in_text && !place.in_card && !place.in_callout
            }
            Self::Note | Self::Stop | Self::Item | Self::File => place.in_parts,
            Self::Tabs => !place.in_text && !place.in_card && !place.in_callout && !place.in_tab,
            Self::Tab => place.in_tabs,
            Self::Callout => !place.in_text && !place.in_callout,
            Self::Code | Self::Diagram | Self::Block | Self::Tree => !place.in_text,
            Self::Jump | Self::Symbol | Self::Icon => !place.top,
        }
    }

    pub fn home(self) -> &'static str {
        match self {
            Self::Row => "at the top level, between paragraphs",
            Self::Card => "between paragraphs, outside other cards and callouts",
            Self::Walk | Self::Trace | Self::Check => "between paragraphs, outside cards and callouts",
            Self::Note => "directly inside a diffle-walk, or a diffle-diagram after its <svg>",
            Self::Stop => "directly inside a diffle-trace",
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
        let inside = Place { top: false, in_parts: false, in_tabs: false, in_details: false, ..place };
        match self {
            Self::Card => Place { in_card: true, ..inside },
            Self::Callout => Place { in_callout: true, ..inside },
            Self::Note | Self::Stop | Self::Item | Self::File => Place { in_text: true, ..inside },
            Self::Walk | Self::Trace | Self::Diagram | Self::Check | Self::Tree => Place { in_parts: true, ..inside },
            Self::Tabs => Place { in_tabs: true, ..inside },
            Self::Tab => Place { in_tab: true, ..inside },
            _ => inside,
        }
    }
}

/// Why a plain `tag` cannot sit at `place`, if it cannot.
pub fn misplaced(tag: &str, place: Place) -> Option<&'static str> {
    match tag {
        "h1" if !place.top => Some("<h1> sits at the top level, where it titles the tour"),
        "h2" | "h3" if !place.top => Some("a heading sits at the top level, where it starts a section"),
        "details" if place.in_text => Some("<details> is a block: it sits between paragraphs"),
        "summary" if !place.in_details => Some("<summary> sits first in a <details>, saying what opening it shows"),
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
