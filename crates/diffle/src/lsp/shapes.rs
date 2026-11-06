//! LSP wire shapes, only the fields read here, and how they become diffle's answers.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::protocol::{LspFeature, LspSymbol};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Pos {
    pub line: i64,
    pub character: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
}

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

/// The `initialize` capability (a boolean or an options object) that advertises `f`.
pub fn provider_of(f: LspFeature) -> &'static str {
    match f {
        LspFeature::Definition => "definitionProvider",
        LspFeature::TypeDefinition => "typeDefinitionProvider",
        LspFeature::Hover => "hoverProvider",
        LspFeature::References => "referencesProvider",
        LspFeature::DocumentSymbol => "documentSymbolProvider",
        LspFeature::WorkspaceSymbol => "workspaceSymbolProvider",
        LspFeature::DocumentHighlight => "documentHighlightProvider",
    }
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
pub fn client_capabilities() -> Value {
    json!({
        "window": { "workDoneProgress": true },
        "textDocument": {
            "synchronization": { "didSave": false },
            "definition": { "dynamicRegistration": true, "linkSupport": true },
            "typeDefinition": { "dynamicRegistration": true, "linkSupport": true },
            "references": { "dynamicRegistration": true },
            "documentHighlight": { "dynamicRegistration": true },
            "hover": { "dynamicRegistration": true, "contentFormat": ["markdown", "plaintext"] },
            "documentSymbol": { "dynamicRegistration": true, "hierarchicalDocumentSymbolSupport": true },
        },
        "workspace": {
            "symbol": { "dynamicRegistration": true },
            "workspaceFolders": true,
            "configuration": true,
        },
    })
}

/// A diffle position (1-based line, 0-based column) on the wire.
pub fn to_lsp(line: i64, col: i64) -> Value {
    json!({ "line": (line - 1).max(0), "character": col.max(0) })
}

/// An LSP range as diffle spans it: (line, col, end line, end col), lines 1-based.
pub fn from_lsp(r: &Range) -> (i64, i64, i64, i64) {
    (r.start.line + 1, r.start.character, r.end.line + 1, r.end.character)
}

fn range(v: Option<&Value>) -> Option<Range> {
    serde_json::from_value(v?.clone()).ok()
}

/// A definition-like result as `(uri, range)` pairs: `Location`, `Location[]`, `LocationLink[]`, or null.
pub fn normalize_locations(result: &Value) -> Vec<(String, Range)> {
    let list = match result {
        Value::Null => return Vec::new(),
        Value::Array(list) => list.iter().collect(),
        single => vec![single],
    };
    list.into_iter()
        .filter_map(|x| {
            if let Some(uri) = x.get("targetUri").and_then(Value::as_str) {
                let r = range(x.get("targetSelectionRange")).or_else(|| range(x.get("targetRange")))?;
                return Some((uri.to_owned(), r));
            }
            Some((x.get("uri")?.as_str()?.to_owned(), range(x.get("range"))?))
        })
        .collect()
}

/// Either symbol shape a server may answer `documentSymbol` with, flattened in document order.
pub fn flatten_symbols(result: &Value, path: &str) -> Vec<LspSymbol> {
    let Some(list) = result.as_array() else { return Vec::new() };
    let hierarchical = list.first().is_some_and(|s| s.get("location").is_none());
    if !hierarchical {
        return list.iter().filter_map(|s| symbol_information(s, path)).collect();
    }
    let mut out = Vec::new();
    walk(list, None, path, &mut out);
    out
}

fn walk(symbols: &[Value], container: Option<&str>, path: &str, out: &mut Vec<LspSymbol>) {
    for s in symbols {
        let (Some(name), Some(kind)) = (s.get("name").and_then(Value::as_str), s.get("kind").and_then(Value::as_i64))
        else {
            continue;
        };
        let (selection, whole) = (range(s.get("selectionRange")), range(s.get("range")));
        let Some(start) = selection.or(whole).map(|r| r.start) else { continue };
        let end = whole.or(selection).map_or(start.line, |r| r.end.line);
        let first = whole.map_or(start.line, |r| r.start.line).min(start.line);
        out.push(LspSymbol {
            name: name.to_owned(),
            kind,
            container: container.map(str::to_owned),
            path: path.to_owned(),
            line: start.line + 1,
            start_line: first + 1,
            end_line: start.line.max(end) + 1,
            col: start.character,
        });
        if let Some(children) = s.get("children").and_then(Value::as_array).filter(|c| !c.is_empty()) {
            walk(children, Some(name), path, out);
        }
    }
}

/// A `SymbolInformation` at `path`; its location may lack a range (`WorkspaceSymbol` resolve-later).
pub fn symbol_information(s: &Value, path: &str) -> Option<LspSymbol> {
    let name = s.get("name")?.as_str()?;
    let kind = s.get("kind")?.as_i64()?;
    let r = range(s.pointer("/location/range"));
    let start = r.map(|r| r.start).unwrap_or_default();
    let end = r.map_or(start, |r| r.end);
    let container = s.get("containerName").and_then(Value::as_str).filter(|c| !c.is_empty());
    Some(LspSymbol {
        name: name.to_owned(),
        kind,
        container: container.map(str::to_owned),
        path: path.to_owned(),
        line: start.line + 1,
        start_line: start.line + 1,
        end_line: start.line.max(end.line) + 1,
        col: start.character,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(line: i64, ch: i64) -> Value {
        json!({ "start": { "line": line, "character": ch }, "end": { "line": line, "character": ch + 1 } })
    }

    #[test]
    fn normalizes_every_location_shape() {
        assert!(normalize_locations(&Value::Null).is_empty());
        let one = normalize_locations(&json!({ "uri": "file:///a", "range": r(1, 2) }));
        assert_eq!((one[0].0.as_str(), one[0].1.start.line), ("file:///a", 1));
        let link = json!([{ "targetUri": "file:///b", "targetRange": r(9, 0), "targetSelectionRange": r(3, 4) }]);
        assert_eq!(normalize_locations(&link)[0].1.start, Pos { line: 3, character: 4 });
        assert_eq!(feature_of("workspace/symbol"), Some(LspFeature::WorkspaceSymbol));
        assert_eq!(feature_of("textDocument/rename"), None);
        assert_eq!(to_lsp(0, -3), json!({ "line": 0, "character": 0 }));
    }

    #[test]
    fn flattens_hierarchical_symbols_with_containers_and_reads_flat_ones() {
        let tree = json!([
            { "name": "Foo", "kind": 5, "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 3, "character": 0 } },
              "selectionRange": r(0, 6),
              "children": [{ "name": "bar", "kind": 6, "range": r(1, 0), "selectionRange": r(1, 8) }] },
        ]);
        let flat: Vec<_> = flatten_symbols(&tree, "a.py")
            .into_iter()
            .map(|s| (s.name, s.container, s.line, s.end_line, s.col))
            .collect();
        assert_eq!(flat, [("Foo".into(), None, 1, 4, 6), ("bar".into(), Some("Foo".into()), 2, 2, 8)]);
        let info = json!([{ "name": "x", "kind": 13, "containerName": "", "location": { "uri": "file:///a" } }]);
        let s = &flatten_symbols(&info, "a.py")[0];
        assert_eq!((s.line, s.end_line, s.container.clone()), (1, 1, None));
    }
}
