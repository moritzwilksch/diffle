//! Deterministic communities for the file graph.
use std::collections::BTreeMap;

/// Edge weights between node indexes. A pair is unordered and counted as listed: `(a, b)` and
/// `(b, a)` add up. Self-pairs and pairs naming a node outside the graph are ignored.
pub type Weights = BTreeMap<(usize, usize), u32>;

/// Passes of local moving before giving up; the spike converged in a handful.
const MAX_PASSES: usize = 20;

/// Groups `nodes` indexes into communities by one level of Louvain local moving: each node, in
/// index order, joins the neighbouring community with the best modularity gain, ties to the lower
/// community id, until a pass moves nobody. Isolated nodes are singletons. Each group is sorted
/// and the groups are ordered by their smallest member, so equal input gives equal output.
pub fn communities(nodes: usize, weights: &Weights) -> Vec<Vec<usize>> {
    let graph = Graph::build(nodes, weights);
    let mut community: Vec<usize> = (0..nodes).collect();
    let mut total = graph.degree.clone();
    for _ in 0..MAX_PASSES {
        let mut moved = false;
        for node in 0..nodes {
            moved |= graph.relocate(node, &mut community, &mut total);
        }
        if !moved {
            break;
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (node, c) in community.into_iter().enumerate() {
        groups.entry(c).or_default().push(node);
    }
    let mut groups: Vec<Vec<usize>> = groups.into_values().collect();
    groups.sort_by_key(|g| g[0]);
    groups
}

struct Graph {
    neighbours: Vec<BTreeMap<usize, i128>>,
    degree: Vec<i128>,
    /// Twice the total edge weight, the `2m` of the modularity formula.
    twice_weight: i128,
}

impl Graph {
    fn build(nodes: usize, weights: &Weights) -> Self {
        let mut neighbours = vec![BTreeMap::new(); nodes];
        let mut degree = vec![0_i128; nodes];
        for (&(a, b), &w) in weights {
            if a == b || a >= nodes || b >= nodes || w == 0 {
                continue;
            }
            let w = i128::from(w);
            *neighbours[a].entry(b).or_insert(0) += w;
            *neighbours[b].entry(a).or_insert(0) += w;
            degree[a] += w;
            degree[b] += w;
        }
        let twice_weight = degree.iter().sum();
        Self { neighbours, degree, twice_weight }
    }

    /// Moves `node` to the neighbouring community that raises modularity most and reports whether
    /// it moved. Gains are compared as exact integers (scaled by `2m`) so no float tie can flip
    /// the outcome, and only a strictly better community beats staying put.
    fn relocate(&self, node: usize, community: &mut [usize], total: &mut [i128]) -> bool {
        let degree = self.degree[node];
        if degree == 0 {
            return false;
        }
        let home = community[node];
        total[home] -= degree;
        let mut linked: BTreeMap<usize, i128> = BTreeMap::from([(home, 0)]);
        for (&other, &w) in &self.neighbours[node] {
            *linked.entry(community[other]).or_insert(0) += w;
        }
        let score = |c: usize, link: i128| link * self.twice_weight - total[c] * degree;
        let stay = score(home, linked[&home]);
        let best = linked
            .iter()
            .map(|(&c, &link)| (score(c, link), c))
            .filter(|&(s, c)| c != home && s > stay)
            .max_by_key(|&(s, c)| (s, std::cmp::Reverse(c)));
        let target = best.map_or(home, |(_, c)| c);
        community[node] = target;
        total[target] += degree;
        target != home
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two 4-cliques (0..4 and 4..8) joined by the single edge 3-4.
    fn barbell() -> Vec<(usize, usize)> {
        let mut edges = Vec::new();
        for base in [0, 4] {
            for a in 0..4 {
                for b in (a + 1)..4 {
                    edges.push((base + a, base + b));
                }
            }
        }
        edges.push((3, 4));
        edges
    }

    fn weights(edges: &[(usize, usize)]) -> Weights {
        let mut w = Weights::new();
        for &(a, b) in edges {
            *w.entry((a.min(b), a.max(b))).or_insert(0) += 1;
        }
        w
    }

    #[test]
    fn two_cliques_and_a_bridge_are_two_communities() {
        let groups = communities(8, &weights(&barbell()));
        assert_eq!(groups, [vec![0, 1, 2, 3], vec![4, 5, 6, 7]]);
    }

    #[test]
    fn repeated_runs_are_identical() {
        let w = weights(&barbell());
        assert_eq!(communities(8, &w), communities(8, &w));
    }

    #[test]
    fn edge_insertion_order_does_not_matter() {
        let mut edges = barbell();
        let forward = communities(8, &weights(&edges));
        edges.reverse();
        let mut rotated = edges.clone();
        rotated.rotate_left(5);
        assert_eq!(communities(8, &weights(&edges)), forward);
        assert_eq!(communities(8, &weights(&rotated)), forward);
    }

    #[test]
    fn the_order_of_a_pair_does_not_matter() {
        let flipped: Vec<(usize, usize)> = barbell().into_iter().map(|(a, b)| (b, a)).collect();
        let mut w = Weights::new();
        for (a, b) in flipped {
            *w.entry((a, b)).or_insert(0) += 1;
        }
        assert_eq!(communities(8, &w), communities(8, &weights(&barbell())));
    }

    #[test]
    fn isolated_nodes_stay_singletons() {
        let groups = communities(10, &weights(&barbell()));
        assert_eq!(groups, [vec![0, 1, 2, 3], vec![4, 5, 6, 7], vec![8], vec![9]]);
    }

    #[test]
    fn no_edges_means_only_singletons() {
        assert_eq!(communities(3, &Weights::new()), [vec![0], vec![1], vec![2]]);
        assert!(communities(0, &Weights::new()).is_empty());
    }

    #[test]
    fn self_loops_and_unknown_nodes_are_ignored() {
        let mut w = weights(&[(0, 1)]);
        w.insert((2, 2), 5);
        w.insert((1, 99), 5);
        assert_eq!(communities(3, &w), [vec![0, 1], vec![2]]);
    }

    #[test]
    fn a_heavier_edge_pulls_a_node_to_its_side() {
        // 1 touches both sides, but its edge to 0 outweighs the one to 2.
        let mut w = Weights::new();
        w.insert((0, 1), 5);
        w.insert((1, 2), 1);
        w.insert((2, 3), 5);
        assert_eq!(communities(4, &w), [vec![0, 1], vec![2, 3]]);
    }
}
