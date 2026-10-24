//! Facts about a snapshot's changed files, assembled into the wire `GraphResponse`.
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;

use super::links::{self, Links};
use super::louvain::{Weights, communities};
use crate::protocol::{GraphCluster, GraphContext, GraphResponse, GraphUse};

/// Unchanged callers a cluster lists, most references first.
const MAX_CONTEXT: usize = 15;
/// Call-site lines kept per used symbol.
pub(super) const MAX_USE_LINES: usize = 5;
/// Arrows a cluster lists, the strongest first.
pub(super) const MAX_LINKS: usize = 150;
/// Used symbols an arrow lists, the most referenced first.
pub(super) const MAX_LINK_USES: usize = 5;

/// A changed symbol, named by where its declaration starts: `path#line:name`. The kind rides along
/// for the reader; the declaration it names never has two.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SymbolKey {
    pub path: String,
    pub line: u32,
    pub name: String,
    /// LSP `SymbolKind` number.
    pub kind: i64,
}

impl fmt::Display for SymbolKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}#{}:{}", self.path, self.line, self.name)
    }
}

/// A changed file a language server could graph, with how many changed symbols it holds.
#[derive(Clone, Debug)]
pub struct GraphFile {
    pub path: String,
    pub symbols: u32,
}

/// One reference between changed symbols: `by` uses `used`.
#[derive(Clone, Debug)]
pub struct SymbolEdge {
    pub used: SymbolKey,
    pub by: SymbolKey,
    /// 1-based lines in `by.path` where the reference sits, sorted, at most the first few.
    pub lines: Vec<u32>,
}

/// Where one unchanged file references a changed symbol: how often, and up to the first lines.
#[derive(Clone, Debug)]
pub struct Callsite {
    pub count: u32,
    pub lines: Vec<u32>,
}

/// Everything `assemble` needs, already collected; no I/O stands behind it.
#[derive(Clone, Debug)]
pub struct Facts {
    pub version: i64,
    /// Graphable changed files in tree order. Louvain visits them in this order, so a stable
    /// order is what keeps clusters stable.
    pub files: Vec<GraphFile>,
    /// Edges naming a file outside `files`, or both ends in one file, link nothing.
    pub edges: Vec<SymbolEdge>,
    /// Unchanged callers per changed symbol, by caller path.
    pub callers: BTreeMap<SymbolKey, BTreeMap<String, Callsite>>,
    /// Changed files that were not graphed, in the order to show them.
    pub other: Vec<String>,
    pub note: Option<String>,
}

/// Unchanged callers of one cluster's symbols: per caller path, its references and the uses.
type Callers<'a> = BTreeMap<&'a str, (u32, Vec<GraphUse>)>;

/// Groups the files by who references whom. Every file of `facts` lands exactly once in a
/// cluster's files, `unlinked` (a community of one) or `other`.
pub fn assemble(facts: Facts) -> GraphResponse {
    let groups = communities(facts.files.len(), &file_weights(&facts));
    let (linked, alone): (Vec<_>, Vec<_>) = groups.into_iter().partition(|members| members.len() > 1);
    let unlinked = alone.iter().flatten().map(|&i| facts.files[i].path.clone()).collect();
    let owner = owners(&facts, &linked);
    let mut callers = bucket_callers(&facts, &owner, linked.len());
    let mut links = links::bucket(&facts.edges, &owner, linked.len());
    let mut clusters: Vec<GraphCluster> = linked
        .iter()
        .zip(callers.iter_mut().zip(&mut links))
        .map(|(members, (callers, links))| cluster(&facts, members, std::mem::take(callers), std::mem::take(links)))
        .collect();
    clusters.sort_by(|a, b| (Reverse(a.files.len()), &a.id).cmp(&(Reverse(b.files.len()), &b.id)));
    GraphResponse { version: facts.version, clusters, unlinked, other: facts.other, note: facts.note }
}

/// The cluster each linked file belongs to, so one pass over callers or edges can bucket them.
fn owners<'a>(facts: &'a Facts, linked: &[Vec<usize>]) -> HashMap<&'a str, usize> {
    linked
        .iter()
        .enumerate()
        .flat_map(|(c, members)| members.iter().map(move |&i| (facts.files[i].path.as_str(), c)))
        .collect()
}

/// Each cluster's unchanged callers, found in one pass over all callers rather than one per cluster.
fn bucket_callers<'a>(facts: &'a Facts, owner: &HashMap<&str, usize>, clusters: usize) -> Vec<Callers<'a>> {
    let mut buckets: Vec<Callers<'a>> = (0..clusters).map(|_| Callers::new()).collect();
    for (symbol, sites) in &facts.callers {
        let Some(&c) = owner.get(symbol.path.as_str()) else { continue };
        for (caller, site) in sites {
            let (refs, uses) = buckets[c].entry(caller).or_default();
            *refs = refs.saturating_add(site.count);
            uses.push(GraphUse {
                symbol: symbol.name.clone(),
                kind: symbol.kind,
                path: symbol.path.clone(),
                lines: use_lines(&site.lines),
            });
        }
    }
    buckets
}

/// Symbol edges folded into undirected file weights over indexes into `facts.files`.
fn file_weights(facts: &Facts) -> Weights {
    let index: BTreeMap<&str, usize> = facts.files.iter().enumerate().map(|(i, f)| (f.path.as_str(), i)).collect();
    let mut weights = Weights::new();
    for edge in &facts.edges {
        if let (Some(&a), Some(&b)) = (index.get(edge.used.path.as_str()), index.get(edge.by.path.as_str()))
            && a != b
        {
            *weights.entry((a.min(b), a.max(b))).or_insert(0) += 1;
        }
    }
    weights
}

fn cluster(facts: &Facts, members: &[usize], callers: Callers<'_>, links: Links) -> GraphCluster {
    let files: Vec<&GraphFile> = members.iter().map(|&i| &facts.files[i]).collect();
    let paths: BTreeSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let context = rank(callers);
    GraphCluster {
        id: paths.first().map(|p| (*p).to_owned()).unwrap_or_default(),
        label: common_directory(&paths),
        files: files.iter().map(|f| f.path.clone()).collect(),
        symbols: files.iter().map(|f| i64::from(f.symbols)).sum(),
        context_total: wire(context.len()),
        context: context.into_iter().take(MAX_CONTEXT).collect(),
        links_total: wire(links.total),
        links: links.items,
    }
}

/// The unchanged callers, ranked: most references, then path.
fn rank(callers: Callers<'_>) -> Vec<GraphContext> {
    let mut ranked: Vec<GraphContext> = callers
        .into_iter()
        .map(|(path, (refs, mut uses))| {
            uses.sort_by(|a, b| (Reverse(a.lines.len()), &a.symbol).cmp(&(Reverse(b.lines.len()), &b.symbol)));
            GraphContext { path: path.to_owned(), uses, refs: i64::from(refs) }
        })
        .collect();
    ranked.sort_by(|a, b| (Reverse(a.refs), &a.path).cmp(&(Reverse(b.refs), &b.path)));
    ranked
}

fn use_lines(lines: &[u32]) -> Vec<i64> {
    let unique: BTreeSet<u32> = lines.iter().copied().collect();
    unique.into_iter().take(MAX_USE_LINES).map(i64::from).collect()
}

/// The deepest directory every path sits in; empty when they share none.
fn common_directory(paths: &BTreeSet<&str>) -> String {
    let mut shared: Option<Vec<&str>> = None;
    for path in paths {
        let dirs: Vec<&str> = path.rsplit_once('/').map_or(Vec::new(), |(dir, _)| dir.split('/').collect());
        shared = Some(match shared {
            None => dirs,
            Some(prefix) => prefix.into_iter().zip(dirs).take_while(|(a, b)| a == b).map(|(a, _)| a).collect(),
        });
    }
    shared.unwrap_or_default().join("/")
}

/// A count on the wire; a `usize` past `i64::MAX` cannot occur, so saturating loses nothing.
pub(super) fn wire(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(path: &str, line: u32, name: &str) -> SymbolKey {
        SymbolKey { path: path.into(), line, name: name.into(), kind: 12 }
    }

    fn file(path: &str, symbols: u32) -> GraphFile {
        GraphFile { path: path.into(), symbols }
    }

    fn edge(used: &SymbolKey, by: &SymbolKey) -> SymbolEdge {
        SymbolEdge { used: used.clone(), by: by.clone(), lines: vec![1] }
    }

    fn facts(files: Vec<GraphFile>, edges: Vec<SymbolEdge>) -> Facts {
        Facts { version: 7, files, edges, callers: BTreeMap::new(), other: Vec::new(), note: None }
    }

    fn callsite(count: u32, lines: &[u32]) -> Callsite {
        Callsite { count, lines: lines.to_vec() }
    }

    /// Files a0..a3 chained to each other, b0..b2 chained, joined by nothing, plus a lone file.
    fn two_features() -> Facts {
        let sym = |p: &str| key(p, 1, "f");
        let mut files = Vec::new();
        let mut edges = Vec::new();
        for (dir, n) in [("a", 4), ("b", 3)] {
            let paths: Vec<String> = (0..n).map(|i| format!("{dir}/f{i}.rs")).collect();
            for p in &paths {
                files.push(file(p, 2));
            }
            for a in 0..paths.len() {
                for b in (a + 1)..paths.len() {
                    edges.push(edge(&sym(&paths[a]), &sym(&paths[b])));
                }
            }
        }
        files.push(file("z/lone.rs", 1));
        facts(files, edges)
    }

    #[test]
    fn clusters_order_by_size_then_id_and_carry_id_label_symbols() {
        let g = assemble(two_features());
        assert_eq!(g.version, 7);
        let shape: Vec<(String, String, usize, i64)> =
            g.clusters.iter().map(|c| (c.id.clone(), c.label.clone(), c.files.len(), c.symbols)).collect();
        assert_eq!(shape, [("a/f0.rs".into(), "a".into(), 4, 8), ("b/f0.rs".into(), "b".into(), 3, 6)]);
        assert_eq!(g.unlinked, ["z/lone.rs"]);
        assert!(g.other.is_empty());
    }

    #[test]
    fn equal_sized_clusters_order_by_id() {
        let mut f = two_features();
        f.files.retain(|x| x.path != "a/f2.rs" && x.path != "a/f3.rs" && x.path != "b/f2.rs");
        f.edges.clear();
        f.edges.push(edge(&key("b/f0.rs", 1, "f"), &key("b/f1.rs", 1, "f")));
        f.edges.push(edge(&key("a/f0.rs", 1, "f"), &key("a/f1.rs", 1, "f")));
        let ids: Vec<String> = assemble(f).clusters.into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["a/f0.rs", "b/f0.rs"]);
    }

    #[test]
    fn the_id_is_the_smallest_path_whatever_the_tree_order() {
        let f = facts(
            vec![file("m/z.rs", 1), file("m/b.rs", 1), file("m/k.rs", 1)],
            vec![
                edge(&key("m/z.rs", 1, "f"), &key("m/b.rs", 1, "f")),
                edge(&key("m/b.rs", 1, "f"), &key("m/k.rs", 1, "f")),
            ],
        );
        let c = &assemble(f).clusters[0];
        assert_eq!(c.id, "m/b.rs");
        assert_eq!(c.files, ["m/z.rs", "m/b.rs", "m/k.rs"]);
    }

    #[test]
    fn the_label_is_the_deepest_shared_directory() {
        let labelled = |paths: &[&str]| {
            let files = paths.iter().map(|p| file(p, 1)).collect::<Vec<_>>();
            let edges = paths.windows(2).map(|w| edge(&key(w[0], 1, "f"), &key(w[1], 1, "f"))).collect();
            assemble(facts(files, edges)).clusters.remove(0).label
        };
        assert_eq!(labelled(&["src/a/x.rs", "src/a/b/y.rs"]), "src/a");
        assert_eq!(labelled(&["src/a/x.rs", "src/c/y.rs"]), "src");
        assert_eq!(labelled(&["src/x.rs", "README.md"]), "");
        assert_eq!(labelled(&["x.rs", "y.rs"]), "");
        assert_eq!(labelled(&["a/b/x.rs", "a/b/y.rs"]), "a/b");
    }

    #[test]
    fn a_directory_name_prefix_is_not_a_shared_directory() {
        let f = facts(
            vec![file("src/ab/x.rs", 1), file("src/abc/y.rs", 1)],
            vec![edge(&key("src/ab/x.rs", 1, "f"), &key("src/abc/y.rs", 1, "f"))],
        );
        assert_eq!(assemble(f).clusters[0].label, "src");
    }

    #[test]
    fn edges_within_one_file_or_to_unknown_files_link_nothing() {
        let f = facts(
            vec![file("a.rs", 2), file("b.rs", 1)],
            vec![edge(&key("a.rs", 1, "f"), &key("a.rs", 9, "g")), edge(&key("a.rs", 1, "f"), &key("gone.rs", 1, "h"))],
        );
        let g = assemble(f);
        assert!(g.clusters.is_empty());
        assert_eq!(g.unlinked, ["a.rs", "b.rs"]);
    }

    #[test]
    fn context_ranks_by_refs_then_path_and_caps_at_fifteen_with_the_total_before_the_cap() {
        let used = key("a/f0.rs", 1, "f");
        let mut f = two_features();
        let mut sites = BTreeMap::new();
        for i in 0..20_u32 {
            sites.insert(format!("ctx/c{i:02}.rs"), callsite(1, &[i + 1]));
        }
        sites.insert("ctx/top.rs".into(), callsite(9, &[1]));
        f.callers.insert(used, sites);
        let c = &assemble(f).clusters[0];
        assert_eq!(c.context_total, 21);
        assert_eq!(c.context.len(), 15);
        assert_eq!(c.context[0].path, "ctx/top.rs");
        assert_eq!(c.context[0].refs, 9);
        assert_eq!(c.context[1].path, "ctx/c00.rs");
        assert_eq!(c.context[14].path, "ctx/c13.rs");
    }

    #[test]
    fn callers_of_several_symbols_aggregate_and_uses_sort_by_lines_then_symbol() {
        let mut f = two_features();
        f.callers.insert(key("a/f0.rs", 1, "zeta"), BTreeMap::from([("ctx/u.rs".to_string(), callsite(1, &[40]))]));
        f.callers.insert(key("a/f1.rs", 3, "alpha"), BTreeMap::from([("ctx/u.rs".to_string(), callsite(1, &[50]))]));
        f.callers
            .insert(key("a/f2.rs", 5, "busy"), BTreeMap::from([("ctx/u.rs".to_string(), callsite(3, &[30, 10, 20]))]));
        let c = &assemble(f).clusters[0];
        assert_eq!(c.context.len(), 1);
        assert_eq!(c.context_total, 1);
        assert_eq!(c.context[0].refs, 5);
        let uses: Vec<(&str, Vec<i64>)> =
            c.context[0].uses.iter().map(|u| (u.symbol.as_str(), u.lines.clone())).collect();
        assert_eq!(uses, [("busy", vec![10, 20, 30]), ("alpha", vec![50]), ("zeta", vec![40])]);
    }

    #[test]
    fn use_lines_are_sorted_unique_and_capped_at_five() {
        let mut f = two_features();
        f.callers.insert(
            key("a/f0.rs", 1, "f"),
            BTreeMap::from([("ctx/u.rs".to_string(), callsite(8, &[9, 3, 3, 8, 1, 7, 2, 6]))]),
        );
        let c = &assemble(f).clusters[0];
        assert_eq!(c.context[0].uses[0].lines, [1, 2, 3, 6, 7]);
        assert_eq!(c.context[0].refs, 8);
    }

    #[test]
    fn callers_of_symbols_outside_a_cluster_stay_out_of_it() {
        let mut f = two_features();
        f.callers.insert(key("b/f0.rs", 1, "f"), BTreeMap::from([("ctx/u.rs".to_string(), callsite(1, &[1]))]));
        let g = assemble(f);
        assert!(g.clusters[0].context.is_empty());
        assert_eq!(g.clusters[0].context_total, 0);
        assert_eq!(g.clusters[1].context_total, 1);
    }

    #[test]
    fn every_file_appears_exactly_once() {
        let mut f = two_features();
        f.other = vec!["docs/readme.md".into(), "img.png".into()];
        f.note = Some("partial".into());
        let inputs: Vec<String> = f.files.iter().map(|x| x.path.clone()).chain(f.other.clone()).collect();
        let g = assemble(f);
        let mut seen: Vec<String> =
            g.clusters.iter().flat_map(|c| c.files.clone()).chain(g.unlinked.clone()).chain(g.other.clone()).collect();
        seen.sort();
        let mut want = inputs;
        want.sort();
        assert_eq!(seen, want);
        assert_eq!(g.other, ["docs/readme.md", "img.png"]);
        assert_eq!(g.note.as_deref(), Some("partial"));
    }

    #[test]
    fn the_same_facts_give_the_same_response_every_time() {
        let a = serde_json::to_string(&assemble(two_features())).unwrap();
        let b = serde_json::to_string(&assemble(two_features())).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn symbol_keys_read_path_line_name() {
        assert_eq!(key("a/b.rs", 12, "run").to_string(), "a/b.rs#12:run");
    }

    /// 400 features of 5 files that all use each other; every file declares 10 symbols, each with one unchanged caller.
    fn at_scale() -> Facts {
        let (mut files, mut edges, mut callers) = (Vec::new(), Vec::new(), BTreeMap::new());
        for feature in 0..400 {
            let paths: Vec<String> = (0..5).map(|i| format!("pkg{feature:03}/f{i}.rs")).collect();
            for (i, path) in paths.iter().enumerate() {
                files.push(file(path, 10));
                for before in &paths[..i] {
                    edges.push(edge(&key(before, 1, "s0"), &key(path, 1, "s0")));
                }
                for symbol in 0..10 {
                    let used = key(path, symbol + 1, &format!("s{symbol}"));
                    let site =
                        BTreeMap::from([(format!("ctx/c{}.rs", (feature + i) % 50), callsite(1, &[symbol + 1]))]);
                    callers.insert(used, site);
                }
            }
        }
        Facts { callers, ..facts(files, edges) }
    }

    #[test]
    fn two_thousand_files_in_four_hundred_clusters_with_twenty_thousand_callers_assemble_quickly() {
        let started = std::time::Instant::now();
        let g = assemble(at_scale());
        let took = started.elapsed();
        assert_eq!((g.clusters.len(), g.unlinked.len(), g.clusters[0].context_total), (400, 0, 5));
        // A debug build on a busy host takes 0.2-0.6 s: the bound is for a pass that blows up, not a slow runner.
        assert!(took < std::time::Duration::from_secs(5), "assembling took {took:?}");
    }
}
