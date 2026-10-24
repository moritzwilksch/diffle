//! Which symbols of a file outline make up its interface, and which of them a patch touches.
use crate::comments::hunks::NewSideChanges;
use crate::protocol::{GraphNodeStatus, LspSymbol};

/// LSP `SymbolKind`s that name an interface rather than an implementation detail: Class, Method,
/// Constructor, Enum, Interface, Function, Constant, Struct and TypeParameter (rust-analyzer's type
/// aliases). Each server maps its language onto these, so the choice holds for every language.
const INTERFACE_KINDS: [i64; 9] = [5, 6, 9, 10, 11, 12, 14, 23, 26];
/// Kinds that only group declarations: Module, Namespace, Package, Class, Enum, Interface, Object
/// (rust-analyzer's `impl`) and Struct. Anything inside another kind, such as a function's local
/// constant or nested `def`, is its implementation.
const NAMESPACE_KINDS: [i64; 8] = [2, 3, 4, 5, 10, 11, 19, 23];

/// The interface-level symbols of a file outline: kinds in `INTERFACE_KINDS`, enclosed only by
/// namespace kinds. Every other function here takes such an outline.
pub fn interface(outline: Vec<LspSymbol>) -> Vec<LspSymbol> {
    // Servers list a parent before its children, which settles equal spans: tsserver gives
    // `const useStore = create(...)` and the callback inside it the same lines.
    let encloses = |(i, a): (usize, &LspSymbol), (j, s): (usize, &LspSymbol)| {
        i < j && a.line <= s.line && s.end_line <= a.end_line
    };
    let keep: Vec<bool> = outline
        .iter()
        .enumerate()
        .map(|s| {
            INTERFACE_KINDS.contains(&s.1.kind)
                && outline.iter().enumerate().all(|a| !encloses(a, s) || NAMESPACE_KINDS.contains(&a.1.kind))
        })
        .collect();
    outline.into_iter().zip(keep).filter_map(|(s, keep)| keep.then_some(s)).collect()
}

/// The innermost symbol of an interface outline whose declaration spans `line`.
pub fn enclosing(outline: &[LspSymbol], line: i64) -> Option<&LspSymbol> {
    outline.iter().filter(|s| s.line <= line && line <= s.end_line).min_by_key(|s| s.end_line - s.line)
}

/// The symbols of an interface outline `changes` falls inside, each the innermost around some
/// change, in outline order. A symbol is added when the patch adds every line of it.
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

    /// class Foo (1-10) holding method bar (2-4) and field x (5); function baz (12-14) holding the
    /// local constant k (13); variable v (16); constant c (18-20) holding a callback over the same lines.
    fn outline() -> Vec<LspSymbol> {
        interface(vec![
            symbol("Foo", 5, 1, 10),
            symbol("bar", 6, 2, 4),
            symbol("x", 8, 5, 5),
            symbol("baz", 12, 12, 14),
            symbol("k", 14, 13, 13),
            symbol("v", 13, 16, 16),
            symbol("c", 14, 18, 20),
            symbol("callback", 12, 18, 20),
        ])
    }

    fn names(changed: &[(LspSymbol, GraphNodeStatus)]) -> Vec<(&str, GraphNodeStatus)> {
        changed.iter().map(|(s, status)| (s.name.as_str(), *status)).collect()
    }

    #[test]
    fn maps_each_change_to_the_innermost_interface_symbol_around_it() {
        let changes = NewSideChanges { added: vec![(3, 3), (5, 5)], removed_at: vec![13, 19] };
        assert_eq!(
            names(&changed_symbols(&outline(), &changes)),
            [
                ("Foo", GraphNodeStatus::Modified),
                ("bar", GraphNodeStatus::Modified),
                ("baz", GraphNodeStatus::Modified),
                ("c", GraphNodeStatus::Modified)
            ]
        );
    }

    #[test]
    fn a_wholly_added_symbol_is_added_and_a_change_outside_every_interface_symbol_is_none() {
        let changes = NewSideChanges { added: vec![(12, 16)], removed_at: vec![] };
        assert_eq!(names(&changed_symbols(&outline(), &changes)), [("baz", GraphNodeStatus::Added)]);
    }
}
