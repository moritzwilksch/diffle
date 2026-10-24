//! Which symbols of a file outline make up its interface, and which of them a patch touches.
use crate::comments::hunks::NewSideChanges;
use crate::protocol::{GraphNodeStatus, LspSymbol};

/// LSP `SymbolKind`s that name an interface rather than an implementation detail: Class, Method,
/// Constructor, Enum, Interface, Function, Constant, Struct and TypeParameter (rust-analyzer's type
/// aliases). Each server maps its language onto these, so the choice holds for every language.
const INTERFACE_KINDS: [i64; 9] = [5, 6, 9, 10, 11, 12, 14, 23, 26];

pub fn is_interface(symbol: &LspSymbol) -> bool {
    INTERFACE_KINDS.contains(&symbol.kind)
}

/// The innermost interface-level symbol whose declaration spans `line`.
pub fn enclosing(outline: &[LspSymbol], line: i64) -> Option<&LspSymbol> {
    outline
        .iter()
        .filter(|s| is_interface(s) && s.line <= line && line <= s.end_line)
        .min_by_key(|s| s.end_line - s.line)
}

/// The symbols `changes` falls inside, each the innermost around some change, in outline order. A
/// symbol is added when the patch adds every line of it.
pub fn changed_symbols(outline: &[LspSymbol], changes: &NewSideChanges) -> Vec<(LspSymbol, GraphNodeStatus)> {
    let lines = changes.added.iter().flat_map(|&(start, end)| start..=end).chain(changes.removed_at.iter().copied());
    let mut hit = vec![false; outline.len()];
    for line in lines {
        if let Some(s) = enclosing(outline, line) {
            hit[outline.iter().position(|o| std::ptr::eq(o, s)).unwrap()] = true;
        }
    }
    outline
        .iter()
        .zip(hit)
        .filter(|(_, hit)| *hit)
        .map(|(s, _)| {
            let status =
                if changes.adds_all(s.line, s.end_line) { GraphNodeStatus::Added } else { GraphNodeStatus::Modified };
            (s.clone(), status)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbol(name: &str, kind: i64, line: i64, end_line: i64) -> LspSymbol {
        LspSymbol { name: name.into(), kind, container: None, path: "a.py".into(), line, end_line, col: 0 }
    }

    /// class Foo (1-10) holding method bar (2-4) and field x (5); function baz (12-14); variable v (16).
    fn outline() -> Vec<LspSymbol> {
        vec![
            symbol("Foo", 5, 1, 10),
            symbol("bar", 6, 2, 4),
            symbol("x", 8, 5, 5),
            symbol("baz", 12, 12, 14),
            symbol("v", 13, 16, 16),
        ]
    }

    fn names(changed: &[(LspSymbol, GraphNodeStatus)]) -> Vec<(&str, GraphNodeStatus)> {
        changed.iter().map(|(s, status)| (s.name.as_str(), *status)).collect()
    }

    #[test]
    fn maps_each_change_to_the_innermost_interface_symbol_around_it() {
        let changes = NewSideChanges { added: vec![(3, 3), (5, 5)], removed_at: vec![13] };
        assert_eq!(
            names(&changed_symbols(&outline(), &changes)),
            [
                ("Foo", GraphNodeStatus::Modified),
                ("bar", GraphNodeStatus::Modified),
                ("baz", GraphNodeStatus::Modified)
            ]
        );
    }

    #[test]
    fn a_wholly_added_symbol_is_added_and_a_change_outside_every_interface_symbol_is_none() {
        let changes = NewSideChanges { added: vec![(12, 16)], removed_at: vec![] };
        assert_eq!(names(&changed_symbols(&outline(), &changes)), [("baz", GraphNodeStatus::Added)]);
    }
}
