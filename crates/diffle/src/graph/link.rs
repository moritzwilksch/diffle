//! Turns the references of changed symbols into edges between them and the code consuming them.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::symbols::enclosing;
use crate::protocol::{GraphEdge, GraphNode, GraphNodeStatus, LspLocation, LspSymbol};

/// Consumers kept per changed symbol, the most-referencing first; the rest are counted.
pub const MAX_CONSUMERS: usize = 5;
/// LSP `SymbolKind` File: a consumer using a symbol from a file's top level.
const FILE_KIND: i64 = 1;

pub fn node_id(symbol: &LspSymbol) -> String {
    format!("{}:{}:{}", symbol.path, symbol.line, symbol.col)
}

/// Links `changed[i]` to the code at `references[i]`. A reference inside a changed symbol is an
/// edge between changed nodes; one inside an unchanged symbol, or outside every symbol of its file,
/// makes a consumer. `outlines` holds the symbols of every file a reference names; a file missing
/// from it has only file-level consumers. References outside the repository, and a symbol's
/// references to itself, are left out.
pub fn link(
    changed: Vec<(LspSymbol, GraphNodeStatus)>,
    references: Vec<Vec<LspLocation>>,
    outlines: &HashMap<String, Vec<LspSymbol>>,
) -> (Vec<GraphNode>, Vec<GraphEdge>) {
    let changed_ids: BTreeSet<String> = changed.iter().map(|(s, _)| node_id(s)).collect();
    let mut edges: BTreeMap<(String, String), BTreeSet<i64>> = BTreeMap::new();
    let mut consumers: BTreeMap<String, GraphNode> = BTreeMap::new();
    let mut nodes = Vec::with_capacity(changed.len());
    for ((symbol, status), locations) in changed.into_iter().zip(references) {
        let to = node_id(&symbol);
        // Per consumer: its node and the lines it references `symbol` from.
        let mut users: BTreeMap<String, (GraphNode, BTreeSet<i64>)> = BTreeMap::new();
        for loc in locations.iter().filter(|l| l.external.is_none()) {
            let line = loc.line.get() as i64;
            let user = user_at(outlines, &loc.path, line);
            if user.id == to {
                continue;
            }
            if changed_ids.contains(&user.id) {
                edges.entry((user.id, to.clone())).or_default().insert(line);
            } else {
                users.entry(user.id.clone()).or_insert_with(|| (user, BTreeSet::new())).1.insert(line);
            }
        }
        let mut ranked: Vec<_> = users.into_values().collect();
        ranked.sort_by(|(a, a_lines), (b, b_lines)| b_lines.len().cmp(&a_lines.len()).then_with(|| a.id.cmp(&b.id)));
        let more = ranked.len().saturating_sub(MAX_CONSUMERS);
        for (user, lines) in ranked.into_iter().take(MAX_CONSUMERS) {
            edges.insert((user.id.clone(), to.clone()), lines);
            consumers.entry(user.id.clone()).or_insert(user);
        }
        nodes.push(node(&symbol, to, status, (more > 0).then_some(more as i64)));
    }
    nodes.extend(consumers.into_values());
    let edges = edges.into_iter().map(|((from, to), lines)| GraphEdge { from, to, lines: lines.into_iter().collect() });
    (nodes, edges.collect())
}

/// The node standing for the code at `path:line`: its enclosing symbol, else the file.
fn user_at(outlines: &HashMap<String, Vec<LspSymbol>>, path: &str, line: i64) -> GraphNode {
    match outlines.get(path).and_then(|o| enclosing(o, line)) {
        Some(symbol) => node(symbol, node_id(symbol), GraphNodeStatus::Consumer, None),
        None => GraphNode {
            id: path.to_owned(),
            name: path.to_owned(),
            kind: FILE_KIND,
            container: None,
            path: path.to_owned(),
            line: 1,
            start_line: 1,
            end_line: 1,
            col: 0,
            status: GraphNodeStatus::Consumer,
            more_consumers: None,
        },
    }
}

pub fn node(symbol: &LspSymbol, id: String, status: GraphNodeStatus, more_consumers: Option<i64>) -> GraphNode {
    GraphNode {
        id,
        name: symbol.name.clone(),
        kind: symbol.kind,
        container: symbol.container.clone(),
        path: symbol.path.clone(),
        line: symbol.line,
        start_line: symbol.start_line,
        end_line: symbol.end_line,
        col: symbol.col,
        status,
        more_consumers,
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use super::*;

    fn symbol(path: &str, name: &str, line: i64, end_line: i64) -> LspSymbol {
        LspSymbol {
            name: name.into(),
            kind: 12,
            container: None,
            path: path.into(),
            line,
            start_line: line,
            end_line,
            col: 4,
        }
    }

    fn at(path: &str, line: u64) -> LspLocation {
        LspLocation {
            path: path.to_owned().try_into().unwrap(),
            line: NonZeroU64::new(line).unwrap(),
            col: 0,
            text: String::new(),
            external: None,
        }
    }

    fn edge_list(edges: &[GraphEdge]) -> Vec<(&str, &str, Vec<i64>)> {
        edges.iter().map(|e| (e.from.as_str(), e.to.as_str(), e.lines.clone())).collect()
    }

    #[test]
    fn links_changed_symbols_to_each_other_and_to_unchanged_consumers() {
        let (core, runner, cli) =
            (symbol("core.py", "core", 1, 3), symbol("run.py", "run", 1, 5), symbol("cli.py", "main", 2, 4));
        let outlines = HashMap::from([
            ("core.py".to_owned(), vec![core.clone()]),
            ("run.py".to_owned(), vec![runner.clone()]),
            ("cli.py".to_owned(), vec![cli.clone()]),
        ]);
        let changed = vec![(core, GraphNodeStatus::Modified), (runner, GraphNodeStatus::Added)];
        let references = vec![
            // core: its own declaration, used twice by run, once from cli's main, and by an import
            // at cli.py's top level; one site lies outside the repository.
            vec![
                at("core.py", 1),
                at("run.py", 2),
                at("run.py", 3),
                at("cli.py", 3),
                at("cli.py", 1),
                LspLocation { external: Some(true), ..at("/usr/lib/x.py", 1) },
            ],
            vec![at("cli.py", 3)],
        ];
        let (nodes, edges) = link(changed, references, &outlines);
        let ids: Vec<_> = nodes.iter().map(|n| (n.id.as_str(), n.status)).collect();
        assert_eq!(
            ids,
            [
                ("core.py:1:4", GraphNodeStatus::Modified),
                ("run.py:1:4", GraphNodeStatus::Added),
                ("cli.py", GraphNodeStatus::Consumer),
                ("cli.py:2:4", GraphNodeStatus::Consumer),
            ]
        );
        assert_eq!(
            edge_list(&edges),
            [
                ("cli.py", "core.py:1:4", vec![1]),
                ("cli.py:2:4", "core.py:1:4", vec![3]),
                ("cli.py:2:4", "run.py:1:4", vec![3]),
                ("run.py:1:4", "core.py:1:4", vec![2, 3]),
            ]
        );
    }

    #[test]
    fn keeps_the_most_referencing_consumers_and_counts_the_rest() {
        let target = symbol("t.py", "t", 1, 1);
        let users: Vec<_> = (0..MAX_CONSUMERS + 2).map(|i| format!("u{i}.py")).collect();
        // u0 references twice, so it ranks first; the others tie and sort by id.
        let mut refs: Vec<_> = users.iter().map(|u| at(u, 1)).collect();
        refs.push(at("u0.py", 2));
        let (nodes, _) = link(vec![(target, GraphNodeStatus::Modified)], vec![refs], &HashMap::new());
        assert_eq!(nodes[0].more_consumers, Some(2));
        let kept: Vec<_> = nodes[1..].iter().map(|n| n.id.as_str()).collect();
        assert_eq!(kept, ["u0.py", "u1.py", "u2.py", "u3.py", "u4.py"]);
    }
}
