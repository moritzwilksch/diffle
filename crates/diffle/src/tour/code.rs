//! A `diffle-code` block: the code it holds, what its attributes may combine, and the warnings that
//! keep it to signatures, interfaces and short made-up examples rather than code the diff shows.
use std::collections::HashSet;

use super::dom::{Dom, Node, NodeId};
use super::files::column;
use crate::protocol::TourError;

/// Past this many lines a block shows more than an interface.
const LONG: usize = 12;
/// Past this many lines an example shows more than the point needs.
const LONG_EXAMPLE: usize = 20;
/// Lines led by a file path, from which a block lists files.
const LISTED: usize = 3;
/// The warning on a block that lists files.
pub const LISTS_FILES: &str = "Lists files: use a diffle-tree, which shows each file's status and line counts";
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
    /// Made up by the agent, not from the repository.
    pub example: bool,
    pub lines: Vec<String>,
}

/// Whether a `diffle-code` under `node` holds markup: a raw `<` the parser read as a tag, which may
/// have cut the block short and moved what follows into or beside it.
pub fn holds_markup(dom: &Dom, node: NodeId) -> bool {
    dom.children(node).iter().any(|&c| match dom.node(c) {
        Node::Element { name, .. } if &*name.local == "diffle-code" => {
            dom.children(c).iter().any(|&g| matches!(dom.node(g), Node::Element { .. }))
        }
        Node::Element { .. } => holds_markup(dom, c),
        _ => false,
    })
}

/// Why a `diffle-code` with `attrs` is refused: attributes that do not go together.
pub fn refusals(attrs: &[(String, String)]) -> Vec<&'static str> {
    let has = |name: &str| attrs.iter().any(|(key, _)| key == name);
    let mut found = Vec::new();
    if has("example") && (has("path") || has("line")) {
        found.push("an example is made up, not from a file: it takes no path or line");
    } else if has("line") && !has("path") {
        found.push("line counts in a path: give diffle-code its path");
    }
    if !has("path") && !has("lang") {
        found.push("diffle-code takes lang when it has no path to name it");
    }
    if has("title") && !has("example") {
        found.push("title names an example: add example, or drop title");
    }
    found
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
    // A re-typed excerpt differs in spacing and trailing punctuation only.
    let loose: HashSet<String> = changed.iter().map(|l| loosely(l)).collect();
    let retyped = telling.iter().filter(|l| loose.contains(&loosely(l))).count();
    if telling.len() >= 2 && repeated * 2 > telling.len() {
        warn("Repeats the diff: show these lines with diffle-diff".into());
    } else if telling.len() >= 2 && retyped * 2 >= telling.len() {
        warn(format!(
            "May re-type the diff: {retyped} of {} lines match changed lines but for spacing; show changed code with diffle-diff",
            telling.len()
        ));
    }
    if lists_files(&code.lines) {
        warn(LISTS_FILES.into());
    }
    let n = code.lines.len();
    if code.example && n > LONG_EXAMPLE {
        warn(format!("Long for an example, at {n} lines: keep only what shows the point"));
    } else if !code.example && n > LONG {
        warn(format!("Long for a signature block, at {n} lines: show only the interface"));
    }
    found
}

/// Whether `lines` list files: at least three lines, and most of them, start with a file path once
/// list or tree marks such as `- ` or `├── ` are cut.
pub fn lists_files(lines: &[String]) -> bool {
    let lines: Vec<&str> = lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let paths = lines.iter().filter(|l| leads_with_path(l)).count();
    paths >= LISTED && paths * 2 > lines.len()
}

/// Whether `line`'s first word, past any list or tree marks, is a file path: it holds a `/` or ends
/// in an extension, and nothing a line of code would (no call, no operator).
fn leads_with_path(line: &str) -> bool {
    let line = line.trim_start_matches(|c: char| !(c.is_alphanumeric() || "._/@~".contains(c)));
    let word = line.split_whitespace().next().unwrap_or_default().trim_end_matches([':', ',']);
    let plain = |c: char| c.is_alphanumeric() || "._/-@~".contains(c);
    let extension = word.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty() && (1..=4).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
    });
    !word.is_empty() && word.chars().all(plain) && !word.starts_with("//") && (word.contains('/') || extension)
}

/// `line` without its whitespace and trailing `,` or `;`.
fn loosely(line: &str) -> String {
    let squeezed: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    squeezed.trim_end_matches([',', ';']).to_owned()
}

/// The name the first declaration in `lines` declares: the word after a keyword such as `fn`.
fn declared(lines: &[String]) -> Option<&str> {
    lines.iter().find_map(|line| {
        let mut words = line.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty());
        words.find(|w| DECLARES.contains(w))?;
        words.next()
    })
}

#[cfg(test)]
mod tests {
    use super::lists_files;

    fn listing(text: &str) -> bool {
        lists_files(&text.lines().map(str::to_owned).collect::<Vec<_>>())
    }

    #[test]
    fn a_column_of_paths_lists_files() {
        assert!(listing("src/auth.rs        NEW  validate tokens\nsrc/store.rs   MOD  keeps ticks\nREADME.md  MOD"));
        assert!(listing("- crates/a.rs\n- crates/b.rs\n- package.json"));
        assert!(listing("├── src/main.rs\n├── src/lib.rs\n└── Cargo.toml"));
    }

    #[test]
    fn code_does_not() {
        assert!(!listing("import { a } from './a.js';\nimport { b } from './b.js';\nimport { c } from './c.js';"));
        assert!(!listing("self.store.get(id)\nconfig.load()\nx.len()"));
        assert!(!listing("// see src/a.rs\n// and src/b.rs\n// and src/c.rs"));
        assert!(!listing("src/a.rs\nsrc/b.rs"));
        assert!(!listing("fn a();\nfn b();\nsrc/a.rs\nsrc/b.rs\nsrc/c.rs\nfn c();\nfn d();"));
    }
}
