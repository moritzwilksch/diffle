//! LSP wire shapes: what diffle tells servers, and how their answers become diffle's.
use async_lsp::lsp_types::{
    ClientCapabilities, DocumentHighlightClientCapabilities, DocumentSymbol, DocumentSymbolClientCapabilities,
    DocumentSymbolResponse, DynamicRegistrationClientCapabilities, GotoCapability, GotoDefinitionResponse,
    HoverClientCapabilities, Location, MarkupKind, OneOf, Position, Range, SymbolInformation, SymbolKind,
    TextDocumentClientCapabilities, TextDocumentSyncClientCapabilities, Url, WindowClientCapabilities,
    WorkspaceClientCapabilities, WorkspaceSymbolClientCapabilities, WorkspaceSymbolResponse,
};

use crate::protocol::{LspFeature, LspSymbol};

/// Every feature diffle asks servers for, in the order the status lists them.
pub fn all_features() -> [LspFeature; 7] {
    [
        LspFeature::Definition,
        LspFeature::TypeDefinition,
        LspFeature::Hover,
        LspFeature::References,
        LspFeature::DocumentSymbol,
        LspFeature::WorkspaceSymbol,
        LspFeature::DocumentHighlight,
    ]
}

/// The method a request for `f`, or a later `client/registerCapability` for it, names.
pub fn method_of(f: LspFeature) -> &'static str {
    match f {
        LspFeature::Definition => "textDocument/definition",
        LspFeature::TypeDefinition => "textDocument/typeDefinition",
        LspFeature::Hover => "textDocument/hover",
        LspFeature::References => "textDocument/references",
        LspFeature::DocumentSymbol => "textDocument/documentSymbol",
        LspFeature::WorkspaceSymbol => "workspace/symbol",
        LspFeature::DocumentHighlight => "textDocument/documentHighlight",
    }
}

/// The feature a registration's method names, or none for one diffle never asks for.
pub fn feature_of(method: &str) -> Option<LspFeature> {
    all_features().into_iter().find(|f| method_of(*f) == method)
}

/// What diffle tells a server it can do. Every feature allows dynamic registration, so a server
/// that advertises after `initialize` is still asked.
pub fn client_capabilities() -> ClientCapabilities {
    let goto = Some(GotoCapability { dynamic_registration: Some(true), link_support: Some(true) });
    ClientCapabilities {
        window: Some(WindowClientCapabilities { work_done_progress: Some(true), ..Default::default() }),
        text_document: Some(TextDocumentClientCapabilities {
            synchronization: Some(TextDocumentSyncClientCapabilities { did_save: Some(false), ..Default::default() }),
            definition: goto,
            type_definition: goto,
            references: Some(DynamicRegistrationClientCapabilities { dynamic_registration: Some(true) }),
            document_highlight: Some(DocumentHighlightClientCapabilities { dynamic_registration: Some(true) }),
            hover: Some(HoverClientCapabilities {
                dynamic_registration: Some(true),
                content_format: Some(vec![MarkupKind::Markdown, MarkupKind::PlainText]),
            }),
            document_symbol: Some(DocumentSymbolClientCapabilities {
                dynamic_registration: Some(true),
                hierarchical_document_symbol_support: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        }),
        workspace: Some(WorkspaceClientCapabilities {
            symbol: Some(WorkspaceSymbolClientCapabilities { dynamic_registration: Some(true), ..Default::default() }),
            workspace_folders: Some(true),
            configuration: Some(true),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// A diffle position (1-based line, 0-based column) on the wire.
pub fn to_lsp(line: i64, col: i64) -> Position {
    Position::new((line - 1).max(0) as u32, col.max(0) as u32)
}

/// An LSP range as diffle spans it: (line, col, end line, end col), lines 1-based.
pub fn from_lsp(r: &Range) -> (i64, i64, i64, i64) {
    let (start, end) = (r.start, r.end);
    (i64::from(start.line) + 1, i64::from(start.character), i64::from(end.line) + 1, i64::from(end.character))
}

/// A definition-like answer as plain locations; a link points at its target's selection.
pub fn locations(answer: Option<GotoDefinitionResponse>) -> Vec<Location> {
    match answer {
        None => Vec::new(),
        Some(GotoDefinitionResponse::Scalar(one)) => vec![one],
        Some(GotoDefinitionResponse::Array(list)) => list,
        Some(GotoDefinitionResponse::Link(links)) => {
            links.into_iter().map(|l| Location::new(l.target_uri, l.target_selection_range)).collect()
        }
    }
}

/// Either symbol shape a server may answer `documentSymbol` with, flattened in document order.
pub fn flatten_symbols(answer: DocumentSymbolResponse, path: &str) -> Vec<LspSymbol> {
    match answer {
        DocumentSymbolResponse::Flat(list) => list.iter().map(|s| symbol_information(s, path)).collect(),
        DocumentSymbolResponse::Nested(tree) => {
            let mut out = Vec::new();
            walk(&tree, None, path, &mut out);
            out
        }
    }
}

fn walk(symbols: &[DocumentSymbol], container: Option<&str>, path: &str, out: &mut Vec<LspSymbol>) {
    for s in symbols {
        let at = Range::new(s.selection_range.start, s.range.end);
        out.push(symbol(&s.name, s.kind, container, Some(at), path));
        if let Some(children) = &s.children {
            walk(children, Some(&s.name), path, out);
        }
    }
}

/// A `SymbolInformation` at `path`.
pub fn symbol_information(s: &SymbolInformation, path: &str) -> LspSymbol {
    symbol(&s.name, s.kind, s.container_name.as_deref(), Some(s.location.range), path)
}

/// A `workspace/symbol` answer as each symbol's file and the symbol at a path; a symbol whose
/// location the server resolves later has no range.
pub fn workspace_symbols(answer: Option<WorkspaceSymbolResponse>) -> Vec<(Url, impl Fn(&str) -> LspSymbol)> {
    let found: Vec<(String, SymbolKind, Option<String>, Location, bool)> = match answer {
        None => Vec::new(),
        Some(WorkspaceSymbolResponse::Flat(list)) => {
            list.into_iter().map(|s| (s.name, s.kind, s.container_name, s.location, true)).collect()
        }
        Some(WorkspaceSymbolResponse::Nested(list)) => list
            .into_iter()
            .map(|s| {
                let (location, ranged) = match s.location {
                    OneOf::Left(location) => (location, true),
                    OneOf::Right(w) => (Location::new(w.uri, Range::default()), false),
                };
                (s.name, s.kind, s.container_name, location, ranged)
            })
            .collect(),
    };
    found
        .into_iter()
        .map(|(name, kind, container, location, ranged)| {
            let range = ranged.then_some(location.range);
            (location.uri, move |path: &str| symbol(&name, kind, container.as_deref(), range, path))
        })
        .collect()
}

/// One symbol as diffle lists it: from where its range starts to the line it ends on.
fn symbol(name: &str, kind: SymbolKind, container: Option<&str>, range: Option<Range>, path: &str) -> LspSymbol {
    let range = range.unwrap_or_default();
    let (line, col, end_line, _) = from_lsp(&range);
    LspSymbol {
        name: name.to_owned(),
        // The wire carries the kind's number; lsp-types keeps it private.
        kind: serde_json::to_value(kind).ok().and_then(|k| k.as_i64()).unwrap_or_default(),
        container: container.filter(|c| !c.is_empty()).map(str::to_owned),
        path: path.to_owned(),
        line,
        end_line: end_line.max(line),
        col,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(line: u32, ch: u32) -> Range {
        Range::new(Position::new(line, ch), Position::new(line, ch + 1))
    }

    #[test]
    fn reads_every_location_shape() {
        assert!(locations(None).is_empty());
        let a = Url::parse("file:///a").unwrap();
        let one = locations(Some(GotoDefinitionResponse::Scalar(Location::new(a.clone(), r(1, 2)))));
        assert_eq!((one[0].uri.as_str(), one[0].range.start.line), ("file:///a", 1));
        let link: GotoDefinitionResponse = serde_json::from_value(json!([{
            "targetUri": "file:///b", "targetRange": r(9, 0), "targetSelectionRange": r(3, 4)
        }]))
        .unwrap();
        assert_eq!(locations(Some(link))[0].range.start, Position::new(3, 4));
        assert_eq!(feature_of("workspace/symbol"), Some(LspFeature::WorkspaceSymbol));
        assert_eq!(feature_of("textDocument/rename"), None);
        assert_eq!(to_lsp(0, -3), Position::new(0, 0));
    }

    #[test]
    fn flattens_hierarchical_symbols_with_containers_and_reads_flat_ones() {
        let tree: DocumentSymbolResponse = serde_json::from_value(json!([
            { "name": "Foo", "kind": 5, "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 3, "character": 0 } },
              "selectionRange": r(0, 6),
              "children": [{ "name": "bar", "kind": 6, "range": r(1, 0), "selectionRange": r(1, 8) }] },
        ]))
        .unwrap();
        let flat: Vec<_> = flatten_symbols(tree, "a.py")
            .into_iter()
            .map(|s| (s.name, s.kind, s.container, s.line, s.end_line, s.col))
            .collect();
        assert_eq!(flat, [("Foo".into(), 5, None, 1, 4, 6), ("bar".into(), 6, Some("Foo".into()), 2, 2, 8)]);
        let info: WorkspaceSymbolResponse = serde_json::from_value(json!([
            { "name": "x", "kind": 13, "containerName": "", "location": { "uri": "file:///a" } }
        ]))
        .unwrap();
        let found = workspace_symbols(Some(info));
        let s = found[0].1("a.py");
        assert_eq!((found[0].0.as_str(), s.line, s.end_line, s.container), ("file:///a", 1, 1, None));
    }
}
