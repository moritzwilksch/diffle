import type { GraphLayout, PlacedNode } from './layout.js';

export type Dir = 'in' | 'out' | 'up' | 'down';

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The candidate nearest to `from` in height; equally near ones by id. */
function nearest(from: PlacedNode, candidates: PlacedNode[]): string | null {
  const ranked = [...candidates].sort((a, b) => Math.abs(a.y - from.y) - Math.abs(b.y - from.y) || byId(a, b));
  return ranked[0]?.id ?? null;
}

/** Follows the arrows of `fromId`: out to a file it uses, in to a file that uses it. */
function along(layout: GraphLayout, from: PlacedNode, dir: 'in' | 'out'): string | null {
  const ids = new Set<string>();
  for (const e of layout.edges) {
    if (dir === 'out' && e.from === from.id) ids.add(e.to);
    if (dir === 'in' && e.to === from.id) ids.add(e.from);
  }
  return nearest(
    from,
    layout.nodes.filter((n) => ids.has(n.id)),
  );
}

/**
 * The previous or next node in reading order: ranks left to right, each top to bottom. Stepping past a
 * rank's end enters the next rank, so the arrow keys alone reach every node whatever the arrows are.
 */
function within(layout: GraphLayout, from: PlacedNode, dir: 'up' | 'down'): string | null {
  const order = [...layout.nodes].sort((a, b) => a.x - b.x || a.y - b.y || byId(a, b));
  const at = order.findIndex((n) => n.id === from.id);
  return order[dir === 'up' ? at - 1 : at + 1]?.id ?? null;
}

/** The node a keyboard step from `fromId` lands on, or null when there is none. */
export function neighbour(layout: GraphLayout, fromId: string, dir: Dir): string | null {
  const from = layout.nodes.find((n) => n.id === fromId);
  if (!from) return null;
  return dir === 'in' || dir === 'out' ? along(layout, from, dir) : within(layout, from, dir);
}

/** Where the keyboard starts: the file with the most links, ties by path; null for an empty layout. */
export function firstNode(layout: GraphLayout): string | null {
  const ranked = [...layout.nodes].sort((a, b) => b.in + b.out - (a.in + a.out) || byId(a, b));
  return ranked[0]?.id ?? null;
}
