import type { PlacedNode } from './layout.js';

export type Direction = 'left' | 'right' | 'up' | 'down';

const centerOf = (p: PlacedNode) => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });

/** The first node in reading order: where arrow keys start with nothing selected. */
export function nearestToOrigin(nodes: PlacedNode[]): PlacedNode | undefined {
  return [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)[0];
}

/** The closest node strictly that way; across layers, sideways distance counts less than the layer gap. */
export function nearest(from: PlacedNode, nodes: PlacedNode[], direction: Direction): PlacedNode | undefined {
  const a = centerOf(from);
  const sameLayer = (p: PlacedNode) => p.y < from.y + from.h && from.y < p.y + p.h;
  const ahead = nodes.filter((p) => {
    if (p === from) return false;
    const b = centerOf(p);
    if (direction === 'up') return b.y < from.y;
    if (direction === 'down') return b.y > from.y + from.h;
    if (!sameLayer(p)) return false;
    return direction === 'left' ? b.x < a.x : b.x > a.x;
  });
  const cost = (p: PlacedNode) => {
    const b = centerOf(p);
    return direction === 'up' || direction === 'down'
      ? Math.abs(b.y - a.y) + 2 * Math.abs(b.x - a.x)
      : Math.abs(b.x - a.x);
  };
  return ahead.sort((p, q) => cost(p) - cost(q))[0];
}
