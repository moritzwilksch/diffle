//! A `diffle-code` block: the code it holds, and the warnings that keep it to signatures and
//! interfaces rather than code the diff already shows.
use std::collections::HashSet;

use super::dom::NodeId;
use super::files::column;
use crate::protocol::TourError;

/// Past this many lines a block shows more than an interface.
const LONG: usize = 12;
/// Keywords after which a declaration names what it declares.
const DECLARES: &[&str] = &[
    "fn",
    "def",
    "class",
    "struct",
    "enum",
    "trait",
    "interface",
    "type",
    "function",
    "func",
    "const",
    "let",
    "var",
    "impl",
    "mod",
    "module",
    "protocol",
    "record",
    "object",
];

/// A `diffle-code` block as the document has it.
pub struct Code {
    pub node: NodeId,
    pub element: String,
    pub path: Option<String>,
    pub line: Option<usize>,
    pub lines: Vec<String>,
}

/// `text` as lines of code: the blank lines around it dropped, the indentation they share removed.
pub fn lines(text: &str) -> Vec<String> {
    let all: Vec<&str> = text.lines().collect();
    let first = all.iter().position(|l| !l.trim().is_empty()).unwrap_or(all.len());
    let last = all.iter().rposition(|l| !l.trim().is_empty()).map_or(first, |i| i + 1);
    let body = &all[first..last];
    let indent =
        body.iter().filter(|l| !l.trim().is_empty()).map(|l| l.len() - l.trim_start().len()).min().unwrap_or(0);
    body.iter().map(|l| l.get(indent..).unwrap_or("").trim_end().to_owned()).collect()
}

/// Every line a patch adds or removes, trimmed.
pub fn changed(patch: &str) -> HashSet<String> {
    patch
        .lines()
        .filter(|l| !l.starts_with("+++") && !l.starts_with("---"))
        .filter_map(|l| l.strip_prefix('+').or_else(|| l.strip_prefix('-')))
        .map(|l| l.trim().to_owned())
        .filter(|l| !l.is_empty())
        .collect()
}

/// The warnings about `code`, given its file's text on the new side and the review's changed lines.
pub fn warnings(code: &Code, text: Option<&str>, changed: &HashSet<String>) -> Vec<TourError> {
    let mut found = Vec::new();
    let mut warn = |message: String| found.push(TourError { element: code.element.clone(), message });
    if let (Some(path), Some(line), Some(text), Some(name)) = (&code.path, code.line, text, declared(&code.lines)) {
        let near: Vec<&str> = text.lines().skip(line.saturating_sub(3)).take(5).collect();
        if !near.iter().any(|l| column(l, name).is_some()) {
            warn(format!("May not match {path}:{line}: {name} isn't there"));
        }
    }
    // Lines with too little to say, such as a closing brace, match anything.
    let telling: Vec<&str> = code
        .lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| l.chars().filter(|c| c.is_alphanumeric()).count() >= 3)
        .collect();
    let repeated = telling.iter().filter(|l| changed.contains(**l)).count();
    if telling.len() >= 2 && repeated * 2 > telling.len() {
        warn("Repeats the diff: show these lines with diffle-diff".into());
    }
    if code.lines.len() > LONG {
        warn(format!("Long for a signature block, at {} lines: show only the interface", code.lines.len()));
    }
    found
}

/// The name the first declaration in `lines` declares: the word after a keyword such as `fn`.
fn declared(lines: &[String]) -> Option<&str> {
    lines.iter().find_map(|line| {
        let mut words = line.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty());
        words.find(|w| DECLARES.contains(w))?;
        words.next()
    })
}
