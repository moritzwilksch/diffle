/** What a layout needs of a node: its id. */
export interface LayoutNode {
  id: string;
}

/** `from` points at `to`. */
export interface LayoutEdge {
  from: string;
  to: string;
}

export interface Graph<N extends LayoutNode = LayoutNode, E extends LayoutEdge = LayoutEdge> {
  nodes: N[];
  edges: E[];
}

/** Where each node of a graph stands between the code nothing uses (entry) and the code using nothing (core). */
export interface Ranked {
  /** Layer per node id, 0 = entry, at the top. Every edge points to a later layer, except inside a cycle. */
  layer: Map<string, number>;
  layers: number;
  /** Martin's instability, out / (in + out): 1 uses only, 0 is only used; 0.5 for an isolated node. */
  instability: Map<string, number>;
  /** The node ids of each cycle, which share a layer. */
  cycles: string[][];
}

/**
 * Ranks by dependency depth, whatever the language: cycles collapse into one unit, and a unit's
 * layer is how far it sits from the deepest core, so core code settles at the bottom and each user sits
 * just above what it uses.
 */
export function rank(graph: Graph): Ranked {
  const ids = graph.nodes.map((n) => n.id);
  const uses = new Map(ids.map((id) => [id, [] as string[]]));
  const usedBy = new Map(ids.map((id) => [id, 0]));
  for (const e of graph.edges) {
    uses.get(e.from)?.push(e.to);
    usedBy.set(e.to, (usedBy.get(e.to) ?? 0) + 1);
  }
  const components = stronglyConnected(ids, uses);
  const unitOf = new Map<string, number>();
  components.forEach((members, unit) => members.forEach((id) => unitOf.set(id, unit)));
  // Tarjan emits a unit after every unit it uses, so heights fill in one pass.
  const height = components.map(() => 0);
  components.forEach((members, unit) => {
    for (const id of members)
      for (const to of uses.get(id)!) {
        const used = unitOf.get(to)!;
        if (used !== unit) height[unit] = Math.max(height[unit]!, height[used]! + 1);
      }
  });
  const layers = Math.max(0, ...height) + 1;
  const layer = new Map(ids.map((id) => [id, layers - 1 - height[unitOf.get(id)!]!]));
  const instability = new Map(
    ids.map((id) => {
      const out = uses.get(id)!.length;
      const total = out + usedBy.get(id)!;
      return [id, total === 0 ? 0.5 : out / total];
    }),
  );
  return { layer, layers, instability, cycles: components.filter((c) => c.length > 1) };
}

/** Tarjan's strongly connected components, each emitted after every component it reaches. */
function stronglyConnected(ids: string[], uses: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (id: string): void => {
    index.set(id, index.size);
    low.set(id, index.get(id)!);
    stack.push(id);
    onStack.add(id);
    for (const to of uses.get(id) ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(id, Math.min(low.get(id)!, low.get(to)!));
      } else if (onStack.has(to)) low.set(id, Math.min(low.get(id)!, index.get(to)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const members: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
    } while (member !== id);
    out.push(members);
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return out;
}

/** Names an edge, for selection and for what lies behind it. */
export const edgeKey = (e: LayoutEdge): string => `${e.from}\0${e.to}`;
