import { describe, expect, it } from 'vitest';
import type { GraphLayout, PlacedNode, RoutedEdge } from '@/client/connected/graph/layout.js';
import type { GraphCluster, GraphLink } from '@/shared/protocol.js';
import { layoutGraph } from '@/client/connected/graph/layout.js';
import { buildGraphModel } from '@/client/connected/graph/model.js';
import { type Dir, firstNode, neighbour } from '@/client/connected/graph/nav.js';

const node = (id: string, x: number, y: number, extra: Partial<PlacedNode> = {}): PlacedNode => ({
  id,
  name: id,
  dir: '',
  status: 'modified',
  add: 0,
  del: 0,
  out: 0,
  in: 0,
  test: false,
  x,
  y,
  w: 148,
  h: 48,
  ...extra,
});
const edge = (from: string, to: string): RoutedEdge => ({
  id: `${from}\u0000${to}`,
  from,
  to,
  weight: 1,
  uses: [],
  total: 0,
  context: false,
  points: [],
  label: { x: 0, y: 0 },
});
const layout = (nodes: PlacedNode[], pairs: [string, string][]): GraphLayout => ({
  nodes,
  edges: pairs.map(([a, b]) => edge(a, b)),
  width: 600,
  height: 400,
});

//  rank 0 (x=100)   rank 1 (x=300)   rank 2 (x=500)
//  top    (y=40)    mid-a (y=40)     leaf (y=100)
//  low    (y=200)   mid-b (y=160)
//                   mid-c (y=300)
const L = layout(
  [
    node('top', 100, 40),
    node('low', 100, 200),
    node('mid-a', 300, 40),
    node('mid-b', 300, 160),
    node('mid-c', 300, 300),
    node('leaf', 500, 100),
    node('lone', 500, 360),
  ],
  [
    ['top', 'mid-a'],
    ['top', 'mid-c'],
    ['low', 'mid-b'],
    ['low', 'mid-c'],
    ['mid-a', 'leaf'],
    ['mid-b', 'leaf'],
  ],
);

describe('neighbour', () => {
  it('out follows an arrow to the callee closest in height', () => {
    expect(neighbour(L, 'top', 'out')).toBe('mid-a');
    expect(neighbour(L, 'low', 'out')).toBe('mid-b');
    expect(neighbour(L, 'mid-b', 'out')).toBe('leaf');
  });

  it('in follows an arrow back to the caller closest in height', () => {
    expect(neighbour(L, 'mid-c', 'in')).toBe('low');
    expect(neighbour(L, 'leaf', 'in')).toBe('mid-a');
    expect(neighbour(L, 'mid-a', 'in')).toBe('top');
  });

  it('breaks height ties by id', () => {
    const tie = layout(
      [node('src', 0, 100), node('b', 200, 60), node('a', 200, 140), node('c', 200, 100), node('d', 200, 100)],
      [
        ['src', 'b'],
        ['src', 'a'],
      ],
    );
    expect(neighbour(tie, 'src', 'out')).toBe('a');
    const same = layout(
      [node('src', 0, 100), node('z', 200, 100), node('y', 200, 100)],
      [
        ['src', 'z'],
        ['src', 'y'],
      ],
    );
    expect(neighbour(same, 'src', 'out')).toBe('y');
  });

  it('up and down step through the same rank by height', () => {
    expect(neighbour(L, 'mid-a', 'down')).toBe('mid-b');
    expect(neighbour(L, 'mid-b', 'down')).toBe('mid-c');
    expect(neighbour(L, 'mid-c', 'up')).toBe('mid-b');
    expect(neighbour(L, 'mid-b', 'up')).toBe('mid-a');
    expect(neighbour(L, 'leaf', 'down')).toBe('lone');
    expect(neighbour(L, 'top', 'down')).toBe('low');
  });

  it('is null where there is nowhere to go', () => {
    expect(neighbour(L, 'top', 'up')).toBeNull();
    expect(neighbour(L, 'lone', 'down')).toBeNull();
    expect(neighbour(L, 'leaf', 'out')).toBeNull();
    expect(neighbour(L, 'top', 'in')).toBeNull();
    expect(neighbour(L, 'lone', 'in')).toBeNull();
    expect(neighbour(L, 'lone', 'out')).toBeNull();
    expect(neighbour(L, 'missing', 'out')).toBeNull();
    expect(neighbour(L, 'missing', 'down')).toBeNull();
    expect(neighbour(layout([], []), 'top', 'up')).toBeNull();
  });

  it('keeps a rank to its own x, and orders equal heights by id', () => {
    const l = layout([node('a', 100, 50), node('b', 101, 80), node('d', 100, 50), node('c', 100, 50)], []);
    expect(neighbour(l, 'a', 'down')).toBe('c');
    expect(neighbour(l, 'c', 'down')).toBe('d');
    expect(neighbour(l, 'a', 'up')).toBeNull();
    expect(neighbour(l, 'b', 'up')).toBe('d');
  });

  it('walks a mutual pair in both directions', () => {
    const l = layout(
      [node('a', 0, 0), node('b', 200, 0)],
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    expect(neighbour(l, 'a', 'out')).toBe('b');
    expect(neighbour(l, 'a', 'in')).toBe('b');
  });
});

describe('firstNode', () => {
  it('is the file with the most links, ties by path', () => {
    const l = layout(
      [
        node('b', 0, 0, { in: 1, out: 1 }),
        node('a', 0, 60, { in: 1, out: 1 }),
        node('hub', 0, 120, { in: 0, out: 3 }),
        node('c', 0, 180, { in: 1, out: 0 }),
      ],
      [],
    );
    expect(firstNode(l)).toBe('hub');
    expect(
      firstNode(
        layout(
          l.nodes.filter((n) => n.id !== 'hub'),
          [],
        ),
      ),
    ).toBe('a');
  });

  it('is null for an empty layout', () => {
    expect(firstNode(layout([], []))).toBeNull();
  });
});

const DIRS: Dir[] = ['in', 'out', 'up', 'down'];

/** The ids a keyboard user can reach from `firstNode` by repeated arrow steps. */
function reachable(l: GraphLayout): Set<string> {
  const start = firstNode(l);
  const seen = new Set<string>(start ? [start] : []);
  const queue = [...seen];
  for (const id of queue) {
    for (const dir of DIRS) {
      const next = neighbour(l, id, dir);
      if (next !== null && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

const link = (from: string, to: string): GraphLink => ({
  from,
  to,
  weight: 1,
  uses: [{ symbol: 'fn', kind: 12, path: to, lines: [1] }],
  total: 1,
});
const clusterOf = (files: string[], links: GraphLink[]): GraphCluster => ({
  id: files[0] ?? '',
  label: '',
  files,
  symbols: 1,
  context: [],
  contextTotal: 0,
  links,
  linksTotal: links.length,
});
const layoutOf = (files: string[], links: GraphLink[], hideTests = false): GraphLayout =>
  layoutGraph(buildGraphModel(clusterOf(files, links), () => undefined, false, hideTests));

describe('the keyboard walk', () => {
  it('up and down continue into the neighbouring rank at a rank end', () => {
    expect(neighbour(L, 'mid-c', 'down')).toBe('leaf');
    expect(neighbour(L, 'leaf', 'up')).toBe('mid-c');
    expect(neighbour(L, 'low', 'down')).toBe('mid-a');
    expect(neighbour(L, 'mid-a', 'up')).toBe('low');
  });

  it('reaches a callee with three callers, one of them a back edge', () => {
    const l = layoutOf(
      ['a.ts', 'b.ts', 'c.ts', 'core.ts'],
      [link('a.ts', 'core.ts'), link('b.ts', 'core.ts'), link('core.ts', 'c.ts'), link('c.ts', 'core.ts')],
    );
    expect([...reachable(l)].sort()).toEqual(['a.ts', 'b.ts', 'c.ts', 'core.ts']);
  });

  it.each([false, true])(
    'reaches every node of 400 seeded random clusters (hide tests: %s)',
    (hideTests) => {
      let s = 20260101;
      const rand = (n: number): number => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s % n;
      };
      for (let round = 0; round < 400; round++) {
        const count = 2 + rand(29);
        // Every third file is a test, so card heights are mixed and `hideTests` has something to drop.
        const files = Array.from(
          { length: count },
          (_, i) => `${i % 3 === 2 ? 'tests' : 'src'}/f${String(i).padStart(2, '0')}.ts`,
        );
        const links: GraphLink[] = [];
        for (let k = rand(count * 2); k > 0; k--) {
          const from = files[rand(count)]!;
          const to = files[rand(count)]!;
          if (from !== to) links.push(link(from, to));
        }
        const l = layoutOf(files, links, hideTests);
        const seen = reachable(l);
        const missing = l.nodes.map((n) => n.id).filter((id) => !seen.has(id));
        expect(missing, `round ${round}: ${count} nodes, ${links.length} links`).toEqual([]);
      }
      // 400 dagre layouts: about 5 s on a loaded host, over vitest's default limit.
    },
    30_000,
  );
});
