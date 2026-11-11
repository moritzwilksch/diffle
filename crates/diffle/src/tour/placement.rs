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
}

impl Place {
    pub const TOP: Self = Self { top: true, in_card: false, in_callout: false, in_text: false };

    /// The place of what a plain `tag` here holds.
    pub fn within(self, tag: &str) -> Self {
        let text = matches!(tag, "p" | "h1" | "h2" | "h3" | "h4" | "a" | "strong" | "em" | "code" | "pre");
        Self { top: false, in_text: self.in_text || text, ..self }
    }
}

/// What a `diffle-*` tag is, deciding where it may sit.
#[derive(Clone, Copy, PartialEq)]
pub enum Rule {
    Row,
    Card,
    Callout,
    Diagram,
    Jump,
    /// `diffle-diff` and `diffle-tree`: blocks holding nothing.
    Block,
    /// `diffle-symbol`: a word of the prose, holding nothing.
    Symbol,
}

impl Rule {
    pub fn of(tag: &str) -> Option<Self> {
        Some(match tag {
            "diffle-row" => Self::Row,
            "diffle-card" => Self::Card,
            "diffle-callout" => Self::Callout,
            "diffle-diagram" => Self::Diagram,
            "diffle-jump" => Self::Jump,
            "diffle-diff" | "diffle-tree" => Self::Block,
            "diffle-symbol" => Self::Symbol,
            _ => return None,
        })
    }

    pub fn fits(self, place: Place) -> bool {
        match self {
            Self::Row => place.top,
            Self::Card => !place.in_text && !place.in_card && !place.in_callout,
            Self::Callout => !place.in_text && !place.in_callout,
            Self::Diagram | Self::Block => !place.in_text,
            Self::Jump | Self::Symbol => !place.top,
        }
    }

    pub fn home(self) -> &'static str {
        match self {
            Self::Row => "at the top level, between paragraphs",
            Self::Card => "between paragraphs, outside other cards and callouts",
            Self::Callout => "between paragraphs, outside other callouts",
            Self::Diagram | Self::Block => "between paragraphs: it is a block, not part of a line of text",
            Self::Jump | Self::Symbol => "inside a paragraph, a list item or other text",
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
