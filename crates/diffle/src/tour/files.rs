//! What a tour's elements ask of the review's files, and whether the snapshot has it.
use super::dom::NodeId;
use crate::protocol::{Side, TourError};

/// One element's claim about a file of the review.
pub struct Reference {
    pub node: NodeId,
    pub element: String,
    pub path: String,
    pub need: Need,
}

pub enum Need {
    /// A file of the review on either side: a tree's path.
    File,
    /// The file exists on that side: a jump without a line.
    Side(Side),
    /// The file has lines `start..=end` on that side.
    Lines { side: Side, start: usize, end: usize },
    /// Line `line` on that side holds `name` as a whole word.
    Name { side: Side, line: usize, name: String },
}

impl Need {
    pub fn side(&self) -> Option<Side> {
        match self {
            Self::File => None,
            Self::Side(side) | Self::Lines { side, .. } | Self::Name { side, .. } => Some(*side),
        }
    }
}

/// Why `reference` does not hold, given whether its path is a file of the review and its text on
/// the side it names (none when absent there).
pub fn refusal(reference: &Reference, is_file: bool, text: Option<&str>) -> Option<TourError> {
    let path = &reference.path;
    let message = match (&reference.need, text) {
        (Need::File, _) if is_file => return None,
        (Need::File, _) => format!("{path} is not a file of the review"),
        (need, None) => format!("{path} is not on the {} side of the review", side_name(need.side()?)),
        (Need::Side(_), Some(_)) => return None,
        (Need::Lines { side, start, end }, Some(text)) => {
            let count = text.lines().count();
            if *end <= count {
                return None;
            }
            let lines = if start == end { format!("line {start} is") } else { format!("lines {start}-{end} are") };
            format!("{lines} past the end of {path}, which has {count} lines on the {} side", side_name(*side))
        }
        (Need::Name { side, line, name }, Some(text)) => {
            let found = text.lines().nth(line - 1).is_some_and(|l| column(l, name).is_some());
            if found {
                return None;
            }
            format!("{name} is not on line {line} of {path} on the {} side", side_name(*side))
        }
    };
    Some(TourError { element: reference.element.clone(), message })
}

/// Where `name` first occurs in `line` as a whole word, in characters.
pub fn column(line: &str, name: &str) -> Option<usize> {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    line.match_indices(name).find_map(|(at, _)| {
        let before = line[..at].chars().next_back();
        let after = line[at + name.len()..].chars().next();
        (!word(before) && !word(after)).then(|| line[..at].chars().count())
    })
}

fn side_name(side: Side) -> &'static str {
    match side {
        Side::Old => "old",
        Side::New => "new",
    }
}

#[cfg(test)]
mod tests {
    use super::column;

    #[test]
    fn finds_whole_words_only() {
        assert_eq!(column("let user_id = id;", "id"), Some(14));
        assert_eq!(column("fn idle()", "id"), None);
        assert_eq!(column("é.run()", "run"), Some(2));
    }
}
