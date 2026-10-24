//! The arrows between a cluster's changed files: who uses whom, through which symbols.
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::assemble::{MAX_LINK_USES, MAX_LINKS, MAX_USE_LINES, SymbolEdge, SymbolKey, wire};
use crate::protocol::{GraphLink, GraphUse};

/// A cluster's arrows, sorted by `from` then `to`, and how many there were before the cap.
#[derive(Default)]
pub struct Links {
    pub items: Vec<GraphLink>,
    pub total: usize,
}

/// One used symbol of an arrow: the symbols that reference it, and where in the referencing file.
#[derive(Default)]
struct Usage<'a> {
    users: BTreeSet<&'a SymbolKey>,
    lines: BTreeSet<u32>,
}

/// The referencing and referenced file of an arrow.
type Ends<'a> = (&'a str, &'a str);
type Arrows<'a> = BTreeMap<Ends<'a>, BTreeMap<&'a SymbolKey, Usage<'a>>>;

/// Every cluster's arrows, from one pass over all edges. An edge links only when both files sit in
/// the same cluster (`owner`), so a cut edge and a same-file edge are left out.
pub fn bucket(edges: &[SymbolEdge], owner: &HashMap<&str, usize>, clusters: usize) -> Vec<Links> {
    let mut arrows: Vec<Arrows<'_>> = (0..clusters).map(|_| Arrows::new()).collect();
    for edge in edges {
        let ends = (edge.by.path.as_str(), edge.used.path.as_str());
        let (Some(&from), Some(&to)) = (owner.get(ends.0), owner.get(ends.1)) else { continue };
        if from != to || ends.0 == ends.1 {
            continue;
        }
        let usage = arrows[from].entry(ends).or_default().entry(&edge.used).or_default();
        usage.users.insert(&edge.by);
        usage.lines.extend(edge.lines.iter().copied());
        while usage.lines.len() > MAX_USE_LINES {
            usage.lines.pop_last();
        }
    }
    arrows.into_iter().map(links_of).collect()
}

fn weight(uses: &BTreeMap<&SymbolKey, Usage<'_>>) -> usize {
    uses.values().map(|u| u.users.len()).sum()
}

/// Keeps the heaviest `MAX_LINKS` arrows, ties by ends, and builds only those.
fn links_of(arrows: Arrows<'_>) -> Links {
    let total = arrows.len();
    let mut ranked: Vec<_> = arrows.into_iter().collect();
    ranked.sort_by_cached_key(|(ends, uses)| (Reverse(weight(uses)), *ends));
    ranked.truncate(MAX_LINKS);
    ranked.sort_by_key(|(ends, _)| *ends);
    Links { items: ranked.into_iter().map(|(ends, uses)| link(ends, uses)).collect(), total }
}

fn link((from, to): Ends<'_>, uses: BTreeMap<&SymbolKey, Usage<'_>>) -> GraphLink {
    let weight = weight(&uses);
    let total = uses.len();
    let mut ranked: Vec<_> = uses.into_iter().collect();
    ranked.sort_by(|(a, ua), (b, ub)| {
        (Reverse(ua.users.len()), &a.name, a.line).cmp(&(Reverse(ub.users.len()), &b.name, b.line))
    });
    let uses = ranked
        .into_iter()
        .take(MAX_LINK_USES)
        .map(|(used, usage)| GraphUse {
            symbol: used.name.clone(),
            kind: used.kind,
            path: used.path.clone(),
            lines: usage.lines.iter().map(|&l| i64::from(l)).collect(),
        })
        .collect();
    GraphLink { from: from.to_owned(), to: to.to_owned(), weight: wire(weight), uses, total: wire(total) }
}

#[cfg(test)]
mod tests {
    use std::cmp::Reverse;
    use std::collections::{BTreeMap, HashMap};

    use super::bucket;
    use crate::graph::assemble::{Facts, GraphFile, SymbolEdge, SymbolKey, assemble};
    use crate::protocol::{GraphCluster, GraphUse};

    const FUNCTION: i64 = 12;
    const CLASS: i64 = 5;

    fn key(path: &str, line: u32, name: &str, kind: i64) -> SymbolKey {
        SymbolKey { path: path.into(), line, name: name.into(), kind }
    }

    fn edge(used: &SymbolKey, by: &SymbolKey, lines: &[u32]) -> SymbolEdge {
        SymbolEdge { used: used.clone(), by: by.clone(), lines: lines.to_vec() }
    }

    fn facts(paths: &[&str], edges: Vec<SymbolEdge>) -> Facts {
        Facts {
            version: 1,
            files: paths.iter().map(|p| GraphFile { path: (*p).into(), symbols: 1 }).collect(),
            edges,
            callers: BTreeMap::new(),
            other: Vec::new(),
            note: None,
        }
    }

    fn only_cluster(facts: Facts) -> GraphCluster {
        let mut g = assemble(facts);
        assert_eq!(g.clusters.len(), 1, "clusters: {:?}", g.clusters.iter().map(|c| c.files.len()).collect::<Vec<_>>());
        g.clusters.remove(0)
    }

    fn shape(c: &GraphCluster) -> Vec<(&str, &str, i64)> {
        c.links.iter().map(|l| (l.from.as_str(), l.to.as_str(), l.weight)).collect()
    }

    #[test]
    fn a_link_runs_from_the_user_to_the_used_with_kind_declaring_path_and_call_site_lines() {
        let (alpha, other) = (key("a.rs", 1, "alpha", FUNCTION), key("a.rs", 9, "Other", CLASS));
        let (beta, gamma) = (key("b.rs", 1, "beta", FUNCTION), key("b.rs", 20, "gamma", FUNCTION));
        let c = only_cluster(facts(
            &["a.rs", "b.rs"],
            vec![edge(&alpha, &beta, &[12, 3]), edge(&alpha, &gamma, &[25, 3]), edge(&other, &beta, &[7])],
        ));
        assert_eq!(shape(&c), [("b.rs", "a.rs", 3)]);
        assert_eq!(c.links_total, 1);
        let link = &c.links[0];
        assert_eq!(link.total, 2);
        let uses: Vec<(&str, i64, &str, Vec<i64>)> =
            link.uses.iter().map(|u| (u.symbol.as_str(), u.kind, u.path.as_str(), u.lines.clone())).collect();
        assert_eq!(
            uses,
            [("alpha", FUNCTION, "a.rs", vec![3, 12, 25]), ("Other", CLASS, "a.rs", vec![7])],
            "most referencing symbols first"
        );
    }

    #[test]
    fn mutual_references_are_two_links_and_a_file_never_links_to_itself() {
        let (a, a2) = (key("a.rs", 1, "a", FUNCTION), key("a.rs", 5, "a2", FUNCTION));
        let b = key("b.rs", 1, "b", FUNCTION);
        let c =
            only_cluster(facts(&["a.rs", "b.rs"], vec![edge(&a, &b, &[2]), edge(&b, &a, &[2]), edge(&a, &a2, &[6])]));
        assert_eq!(shape(&c), [("a.rs", "b.rs", 1), ("b.rs", "a.rs", 1)]);
        assert_eq!(c.links_total, 2);
    }

    #[test]
    fn an_edge_cut_by_clustering_is_in_neither_clusters_links() {
        let f = |p: &str| key(p, 1, "f", FUNCTION);
        let mut edges = Vec::new();
        for pair in [["a/x.rs", "a/y.rs"], ["b/x.rs", "b/y.rs"]] {
            edges.push(edge(&f(pair[0]), &f(pair[1]), &[1]));
            edges.push(edge(&f(pair[1]), &f(pair[0]), &[1]));
        }
        // One weak arrow between the two features: Louvain keeps them apart.
        edges.push(edge(&f("a/x.rs"), &f("b/x.rs"), &[1]));
        let g = assemble(facts(&["a/x.rs", "a/y.rs", "b/x.rs", "b/y.rs"], edges));
        assert_eq!(g.clusters.len(), 2);
        for c in &g.clusters {
            assert_eq!(c.links_total, 2, "{:?}", shape(c));
            assert!(c.links.iter().all(|l| l.from[..1] == c.id[..1] && l.to[..1] == c.id[..1]));
        }
    }

    #[test]
    fn more_than_five_used_symbols_keep_five_and_the_true_total() {
        let by: Vec<SymbolKey> = (0..4).map(|i| key("b.rs", i * 10 + 1, &format!("user{i}"), FUNCTION)).collect();
        let mut edges = Vec::new();
        for n in 0..8_u32 {
            let used = key("a.rs", n + 1, &format!("s{n}"), FUNCTION);
            // s0 is used by four symbols, s1 by three, ... s3 by one, the rest by one.
            let users = 4_usize.saturating_sub(n as usize).max(1);
            edges.extend(by.iter().take(users).map(|b| edge(&used, b, &[n + 1])));
        }
        let c = only_cluster(facts(&["a.rs", "b.rs"], edges));
        let link = &c.links[0];
        assert_eq!((link.total, link.uses.len()), (8, 5));
        let names: Vec<&str> = link.uses.iter().map(|u| u.symbol.as_str()).collect();
        assert_eq!(names, ["s0", "s1", "s2", "s3", "s4"]);
        assert_eq!(link.weight, 4 + 3 + 2 + 1 + 4);
    }

    #[test]
    fn call_site_lines_are_unique_sorted_and_capped_at_five() {
        let (used, by) = (key("a.rs", 1, "a", FUNCTION), key("b.rs", 1, "b", FUNCTION));
        let by2 = key("b.rs", 50, "b2", FUNCTION);
        let c = only_cluster(facts(
            &["a.rs", "b.rs"],
            vec![edge(&used, &by, &[9, 3, 3, 8, 1]), edge(&used, &by2, &[60, 2, 7, 6])],
        ));
        assert_eq!(c.links[0].uses[0].lines, [1, 2, 3, 6, 7]);
    }

    /// Twenty files that each use all the others, and each arrow's (weight, from, to).
    struct Dense {
        paths: Vec<String>,
        edges: Vec<SymbolEdge>,
        arrows: Vec<(i64, String, String)>,
    }

    /// The arrow i -> j has a weight between one and five.
    fn dense() -> Dense {
        let paths: Vec<String> = (0..20).map(|i| format!("m/f{i:02}.rs")).collect();
        let mut edges = Vec::new();
        let mut expected = Vec::new();
        for (i, from) in paths.iter().enumerate() {
            for (j, to) in paths.iter().enumerate().filter(|(j, _)| *j != i) {
                let weight = 1 + ((i * i * 13 + j * j * 7 + i * j * 3) % 5) as i64;
                // One referencing symbol and `weight` used ones: `weight` distinct pairs.
                let by = key(from, 1, "user", FUNCTION);
                edges.extend((0..weight).map(|k| edge(&key(to, 1, &format!("s{k}"), FUNCTION), &by, &[1])));
                expected.push((weight, from.clone(), to.clone()));
            }
        }
        Dense { paths, edges, arrows: expected }
    }

    #[test]
    fn a_cluster_with_hundreds_of_arrows_keeps_the_strongest_hundred_and_fifty_in_order() {
        let Dense { paths, edges, arrows: mut all } = dense();
        // Louvain would split such a graph; the cap is about one cluster, so own them all in cluster 0.
        let owner: HashMap<&str, usize> = paths.iter().map(|p| (p.as_str(), 0)).collect();
        let links = bucket(&edges, &owner, 1).remove(0);
        assert_eq!((links.total, links.items.len()), (380, 150));
        all.sort_by(|a, b| (Reverse(a.0), &a.1, &a.2).cmp(&(Reverse(b.0), &b.1, &b.2)));
        let mut want: Vec<(String, String, i64)> = all.into_iter().take(150).map(|(w, f, t)| (f, t, w)).collect();
        want.sort();
        let got: Vec<(String, String, i64)> =
            links.items.iter().map(|l| (l.from.clone(), l.to.clone(), l.weight)).collect();
        assert_eq!(got, want);
        let weakest = got.iter().map(|(_, _, w)| *w).min().unwrap();
        assert!(weakest >= 3, "the cut keeps the heavy arrows: {weakest}");
    }

    #[test]
    fn the_cap_holds_through_assemble_with_the_total_before_it() {
        let paths: Vec<String> = (0..20).map(|i| format!("m/f{i:02}.rs")).collect();
        let at = |p: &String| key(p, 1, "f", FUNCTION);
        let edges = paths
            .iter()
            .flat_map(|from| paths.iter().filter(move |to| *to != from).map(move |to| (from, to)))
            .map(|(from, to)| edge(&at(to), &at(from), &[1]))
            .collect();
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        let c = only_cluster(facts(&refs, edges));
        assert_eq!((c.links_total, c.links.len()), (380, 150));
        let ends: Vec<(&str, &str)> = c.links.iter().map(|l| (l.from.as_str(), l.to.as_str())).collect();
        assert!(ends.windows(2).all(|w| w[0] < w[1]), "sorted by from then to");
        assert_eq!(ends[0], ("m/f00.rs", "m/f01.rs"), "equal weights keep the first by (from, to)");
    }

    #[test]
    fn the_same_facts_in_any_edge_order_give_byte_identical_output() {
        let Dense { paths, edges, .. } = dense();
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        let facts = facts(&refs, edges);
        let first = serde_json::to_string(&assemble(facts.clone())).unwrap();
        let mut reversed = facts.clone();
        reversed.edges.reverse();
        let mut rotated = facts;
        rotated.edges.rotate_left(97);
        for variant in [reversed, rotated] {
            assert_eq!(serde_json::to_string(&assemble(variant)).unwrap(), first);
        }
    }

    #[test]
    fn context_callers_name_the_kind_and_declaring_file_of_each_use() {
        let (a, b) = (key("a.rs", 1, "alpha", CLASS), key("b.rs", 1, "beta", FUNCTION));
        let mut f = facts(&["a.rs", "b.rs"], vec![edge(&a, &b, &[2])]);
        let site = crate::graph::assemble::Callsite { count: 1, lines: vec![4] };
        f.callers.insert(a, BTreeMap::from([("ctx/u.rs".to_string(), site)]));
        let c = only_cluster(f);
        let GraphUse { symbol, kind, path, lines } = c.context[0].uses[0].clone();
        assert_eq!((symbol.as_str(), kind, path.as_str(), lines), ("alpha", CLASS, "a.rs", vec![4]));
    }
}
