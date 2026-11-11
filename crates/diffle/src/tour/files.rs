//! What a tour's elements ask of the review's files, and whether the snapshot has it.
use super::dom::NodeId;
use crate::protocol::{Side, TourElement, TourError};

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

/// What `element` asks of the review's files, each path with its need, and the reasons it asks
/// nothing sensible: lines that run backwards, a tree path outside its root.
pub fn asks(element: TourElement) -> (Vec<(String, Need)>, Vec<String>) {
    let mut needs = Vec::new();
    let mut errors = Vec::new();
    match element {
        TourElement::DiffleDiff { path, side, lines } | TourElement::DiffleWalk { path, side, lines } => {
            let (start, end) = span(&lines);
            if start > end {
                errors.push(format!("lines {} run backwards", *lines));
            } else {
                needs.push((path.to_string(), Need::Lines { side: side.unwrap_or(Side::New), start, end }));
            }
        }
        TourElement::DiffleTree { paths, root } => {
            for path in paths.lines().map(str::trim).filter(|p| !p.is_empty()) {
                match root.as_deref() {
                    Some(root) if !path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/')) => {
                        errors.push(format!("{path} is not under the root {root}"));
                    }
                    _ => needs.push((path.to_owned(), Need::File)),
                }
            }
        }
        TourElement::DiffleJump { path, line, side } => {
            let side = side.unwrap_or(Side::New);
            let need =
                line.map_or(Need::Side(side), |line| Need::Lines { side, start: number(&line), end: number(&line) });
            needs.push((path.to_string(), need));
        }
        TourElement::DiffleStop { path, line, side } => {
            let line = number(&line);
            needs.push((path.to_string(), Need::Lines { side: side.unwrap_or(Side::New), start: line, end: line }));
        }
        TourElement::DiffleSymbol { path, line, name, side } => {
            let need = Need::Name { side: side.unwrap_or(Side::New), line: number(&line), name: name.to_string() };
            needs.push((path.to_string(), need));
        }
        TourElement::DiffleCode { path: Some(path), line, .. } => {
            let need = line.map_or(Need::File, |line| Need::Lines {
                side: Side::New,
                start: number(&line),
                end: number(&line),
            });
            needs.push((path.to_string(), need));
        }
        TourElement::DiffleCode { path: None, .. }
        | TourElement::DiffleCard { .. }
        | TourElement::DiffleCallout { .. }
        | TourElement::DiffleDiagram
        | TourElement::DiffleRow
        | TourElement::DiffleIcon { .. }
        | TourElement::DiffleNote { .. }
        | TourElement::DiffleTrace
        | TourElement::DiffleTabs
        | TourElement::DiffleTab { .. }
        | TourElement::DiffleCheck
        | TourElement::DiffleItem { .. } => {}
    }
    (needs, errors)
}

/// The first and last line of a `lines` value the schema already matched: `40-58`, or `40`.
pub fn span(lines: &str) -> (usize, usize) {
    lines.split_once('-').map_or((number(lines), number(lines)), |(a, b)| (number(a), number(b)))
}

/// An attribute value the schema already matched as a positive number.
fn number(digits: &str) -> usize {
    digits.parse().unwrap_or(usize::MAX)
}

/// Why `reference` does not hold, given whether its path is a file of the review and its text on
/// the side it names (none when absent there).
pub fn refusal(reference: &Reference, is_file: bool, text: Option<&str>) -> Option<TourError> {
    let path = &reference.path;
    let message = match (&reference.need, text) {
        _ if !is_file => format!("{path} is not a file of the review"),
        (Need::File, _) => return None,
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
