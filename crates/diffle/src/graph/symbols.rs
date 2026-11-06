//! Which symbols of a file outline make up its interface, and which of them a patch touches.
use super::select::Changed;
use crate::comments::hunks::NewSideChanges;
use crate::protocol::{GraphNodeStatus, LspSymbol};

/// LSP `SymbolKind`s that name an interface rather than an implementation detail: Class, Method,
/// Constructor, Enum, Interface, Function, Struct and TypeParameter (rust-analyzer's type aliases).
/// Constants and variables are left out: they are many, and their type says little about the design.
/// Each server maps its language onto these, so the choice holds for every language.
const INTERFACE_KINDS: [i64; 8] = [5, 6, 9, 10, 11, 12, 23, 26];
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
        i < j && a.start_line <= s.start_line && s.end_line <= a.end_line
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

/// The innermost symbol of an interface outline whose declaration, decorators included, spans `line`.
pub fn enclosing(outline: &[LspSymbol], line: i64) -> Option<&LspSymbol> {
    outline.iter().filter(|s| s.start_line <= line && line <= s.end_line).min_by_key(|s| s.end_line - s.start_line)
}

/// The symbols of an interface outline `changes` falls inside, each the innermost around some
/// change, in outline order, with the changed lines it holds. A symbol is added when the patch adds
/// every line of it.
pub fn changed_symbols(outline: &[LspSymbol], changes: &NewSideChanges) -> Vec<Changed> {
    let lines = changes.added.iter().flat_map(|&(start, end)| start..=end).chain(changes.removed_at.iter().copied());
    let mut hits = vec![0; outline.len()];
    for line in lines {
        if let Some(s) = enclosing(outline, line) {
            hits[outline.iter().position(|o| std::ptr::eq(o, s)).unwrap()] += 1;
        }
    }
    outline
        .iter()
        .zip(hits)
        .filter(|(_, hits)| *hits > 0)
        .map(|(s, lines)| {
            let status = if changes.adds_all(s.start_line, s.end_line) {
                GraphNodeStatus::Added
            } else {
                GraphNodeStatus::Modified
            };
            Changed { symbol: s.clone(), status, lines }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbol(name: &str, kind: i64, line: i64, end_line: i64) -> LspSymbol {
        LspSymbol {
            name: name.into(),
            kind,
            container: None,
            path: "a.py".into(),
            line,
            start_line: line,
            end_line,
            col: 0,
        }
    }

    /// class Foo (1-10) holding method bar (2-4) and field x (5); function baz (12-14) holding the
    /// local function k (13); variable v (16); class C (18-20) holding a callback over the same
    /// lines; constant K (22).
    fn outline() -> Vec<LspSymbol> {
        interface(vec![
            symbol("Foo", 5, 1, 10),
            symbol("bar", 6, 2, 4),
            symbol("x", 8, 5, 5),
            symbol("baz", 12, 12, 14),
            symbol("k", 12, 13, 13),
            symbol("v", 13, 16, 16),
            symbol("C", 5, 18, 20),
            symbol("callback", 12, 18, 20),
            symbol("K", 14, 22, 22),
        ])
    }

    fn names(changed: &[Changed]) -> Vec<(&str, GraphNodeStatus)> {
        changed.iter().map(|c| (c.symbol.name.as_str(), c.status)).collect()
    }

    #[test]
    fn maps_each_change_to_the_innermost_interface_symbol_around_it() {
        let changes =
            NewSideChanges { added: vec![(3, 3), (5, 5), (22, 22)], removed_at: vec![13, 19], ..Default::default() };
        assert_eq!(
            names(&changed_symbols(&outline(), &changes)),
            [
                ("Foo", GraphNodeStatus::Modified),
                ("bar", GraphNodeStatus::Modified),
                ("baz", GraphNodeStatus::Modified),
                ("C", GraphNodeStatus::Modified)
            ]
        );
    }

    #[test]
    fn a_wholly_added_symbol_is_added_and_a_change_outside_every_interface_symbol_is_none() {
        let changes = NewSideChanges { added: vec![(12, 16)], ..Default::default() };
        assert_eq!(names(&changed_symbols(&outline(), &changes)), [("baz", GraphNodeStatus::Added)]);
    }

    #[test]
    fn a_change_to_a_decorator_alone_modifies_the_symbol_it_decorates() {
        let route = LspSymbol { start_line: 3, ..symbol("route", 12, 4, 6) };
        let changes = NewSideChanges { added: vec![(3, 3)], ..Default::default() };
        assert_eq!(names(&changed_symbols(&interface(vec![route]), &changes)), [("route", GraphNodeStatus::Modified)]);
    }
}
