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
    /// Directly in a stepped block (a walk, a diagram), where its notes sit.
    pub in_steps: bool,
}

impl Place {
    pub const TOP: Self = Self { top: true, in_card: false, in_callout: false, in_text: false, in_steps: false };

    /// The place of what a plain `tag` here holds.
    pub fn within(self, tag: &str) -> Self {
        let text = matches!(tag, "p" | "h1" | "h2" | "h3" | "h4" | "a" | "strong" | "em" | "code" | "pre");
        Self { top: false, in_text: self.in_text || text, in_steps: false, ..self }
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
    Callout,
    Diagram,
    Jump,
    /// `diffle-diff` and `diffle-tree`: blocks holding nothing.
    Block,
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
            "diffle-callout" => Self::Callout,
            "diffle-diagram" => Self::Diagram,
            "diffle-jump" => Self::Jump,
            "diffle-diff" | "diffle-tree" => Self::Block,
            "diffle-symbol" => Self::Symbol,
            "diffle-icon" => Self::Icon,
            _ => return None,
        })
    }

    pub fn fits(self, place: Place) -> bool {
        match self {
            Self::Row => place.top,
            Self::Card | Self::Walk => !place.in_text && !place.in_card && !place.in_callout,
            Self::Note => place.in_steps,
            Self::Callout => !place.in_text && !place.in_callout,
            Self::Code | Self::Diagram | Self::Block => !place.in_text,
            Self::Jump | Self::Symbol | Self::Icon => !place.top,
        }
    }

    pub fn home(self) -> &'static str {
        match self {
            Self::Row => "at the top level, between paragraphs",
            Self::Card => "between paragraphs, outside other cards and callouts",
            Self::Walk => "between paragraphs, outside cards and callouts",
            Self::Note => "directly inside a diffle-walk, or a diffle-diagram after its <svg>",
            Self::Callout => "between paragraphs, outside other callouts",
            Self::Code | Self::Diagram | Self::Block => "between paragraphs: it is a block, not part of a line of text",
            Self::Jump | Self::Symbol | Self::Icon => "inside a paragraph, a list item or other text",
        }
    }
}

/// Why a plain `tag` cannot sit at `place`, if it cannot.
pub fn misplaced(tag: &str, place: Place) -> Option<&'static str> {
    match tag {
        "h1" if !place.top => Some("<h1> sits at the top level, where it titles the tour"),
        "h2" | "h3" if !place.top => Some("a heading sits at the top level, where it starts a section"),
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
