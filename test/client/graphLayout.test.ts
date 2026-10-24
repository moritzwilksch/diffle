import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphModel, GraphNode } from '@/client/connected/graph/model.js';
import { layoutGraph } from '@/client/connected/graph/layout.js';

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  name: id.slice(id.lastIndexOf('/') + 1),
  dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
  status: 'modified',
  add: 1,
  del: 0,
  out: 0,
  in: 0,
  test: false,
  ...extra,
});
const edge = (from: string, to: string): GraphEdge => ({
  id: `${from}\u0000${to}`,
  from,
  to,
  weight: 1,
  uses: [],
  total: 0,
  context: false,
});
const model = (ids: string[], pairs: [string, string][]): GraphModel => ({
  nodes: ids.map((id) => node(id)),
  edges: pairs.map(([a, b]) => edge(a, b)),
  files: ids.length,
  links: pairs.length,
  hiddenFiles: 0,
  hiddenLinks: 0,
  hiddenTests: 0,
});
const shuffled = <T>(xs: T[], seed: number): T[] => {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};
const dist = (p: { x: number; y: number }, n: { x: number; y: number }) => Math.hypot(p.x - n.x, p.y - n.y);

describe('layoutGraph with test files', () => {
  const mixed = (): GraphModel => ({
    ...model(
      ['src/a.ts', 'src/b.ts', 'tests/a.test.ts'],
      [
        ['src/a.ts', 'src/b.ts'],
        ['tests/a.test.ts', 'src/a.ts'],
      ],
    ),
    nodes: [node('src/a.ts'), node('src/b.ts'), node('tests/a.test.ts', { test: true })],
  });

  it('draws a test card lower than a source card, and never overlaps its neighbours', () => {
    const l = layoutGraph(mixed());
    const t = l.nodes.find((n) => n.test)!;
    const src = l.nodes.find((n) => !n.test)!;
    expect(t.h).toBeLessThan(src.h);
    for (const a of l.nodes)
      for (const b of l.nodes) {
        if (a.id >= b.id) continue;
        const apart = Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
  });

  it('stays deterministic with mixed heights', () => {
    const m = mixed();
    const base = layoutGraph(m);
    for (const seed of [1, 2, 3])
      expect(layoutGraph({ ...m, nodes: shuffled(m.nodes, seed), edges: shuffled(m.edges, seed + 5) })).toEqual(base);
  });
});

describe('layoutGraph', () => {
  it('places callers left of callees and sizes nodes from the label', () => {
    const l = layoutGraph(model(['a.ts', 'b.ts', 'long/' + 'x'.repeat(60) + '.ts'], [['a.ts', 'b.ts']]));
    const a = l.nodes.find((n) => n.id === 'a.ts')!;
    const b = l.nodes.find((n) => n.id === 'b.ts')!;
    expect(a.x).toBeLessThan(b.x);
    expect([a.w, a.h]).toEqual([148, 48]);
    expect(l.nodes.find((n) => n.name.startsWith('xxx'))!.w).toBe(280);
    expect(l.width).toBeGreaterThan(b.x);
    expect(l.height).toBeGreaterThan(0);
  });

  it('rounds every coordinate to an integer', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `d/f${i}.ts`);
    const pairs = ids.slice(1).map((id, i): [string, string] => [ids[(i * 5) % 12]!, id]);
    const l = layoutGraph(
      model(
        ids,
        pairs.filter(([a, b]) => a !== b),
      ),
    );
    const nums = [
      l.width,
      l.height,
      ...l.nodes.flatMap((n) => [n.x, n.y, n.w, n.h]),
      ...l.edges.flatMap((e) => [e.label.x, e.label.y, ...e.points.flatMap((p) => [p.x, p.y])]),
    ];
    expect(nums.every(Number.isInteger)).toBe(true);
  });

  it('routes each edge from its caller to its callee, a mutual pair included', () => {
    const l = layoutGraph(
      model(
        ['a.ts', 'b.ts', 'c.ts'],
        [
          ['a.ts', 'b.ts'],
          ['b.ts', 'a.ts'],
          ['b.ts', 'c.ts'],
        ],
      ),
    );
    expect(l.edges).toHaveLength(3);
    const at = (id: string) => l.nodes.find((n) => n.id === id)!;
    for (const e of l.edges) {
      const first = e.points[0]!;
      const last = e.points[e.points.length - 1]!;
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      expect(dist(first, at(e.from))).toBeLessThan(dist(first, at(e.to)));
      expect(dist(last, at(e.to))).toBeLessThan(dist(last, at(e.from)));
    }
  });

  it('puts the label on the middle of the polyline', () => {
    const l = layoutGraph(model(['a.ts', 'b.ts'], [['a.ts', 'b.ts']]));
    const e = l.edges[0]!;
    const xs = e.points.map((p) => p.x);
    expect(e.label.x).toBeGreaterThanOrEqual(Math.min(...xs));
    expect(e.label.x).toBeLessThanOrEqual(Math.max(...xs));
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    expect(Math.abs(e.label.x - mid)).toBeLessThanOrEqual(1);
  });

  it('keeps the edge payload and the model order', () => {
    const m = model(['b.ts', 'a.ts'], [['a.ts', 'b.ts']]);
    m.edges[0]!.uses = [{ symbol: 's', kind: 12, path: 'b.ts', lines: [1] }];
    const l = layoutGraph(m);
    expect(l.edges[0]).toMatchObject({
      id: m.edges[0]!.id,
      from: 'a.ts',
      to: 'b.ts',
      weight: 1,
      uses: m.edges[0]!.uses,
    });
    expect(l.nodes.map((n) => n.id)).toEqual(['a.ts', 'b.ts']);
  });

  it('is deterministic: the same model and shuffled copies give the same layout', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `d${i % 5}/f${String(i).padStart(2, '0')}.ts`);
    const pairs: [string, string][] = ids.flatMap((id, i): [string, string][] => [
      [id, ids[(i * 7 + 1) % 40]!],
      [id, ids[(i * 3 + 2) % 40]!],
    ]);
    const clean = pairs.filter(([a, b]) => a !== b);
    const base = layoutGraph(model(ids, clean));
    expect(layoutGraph(model(ids, clean))).toEqual(base);
    for (const seed of [1, 2, 3, 4]) {
      const m = model(shuffled(ids, seed), shuffled(clean, seed + 9));
      // the model contract is id-sorted; a caller that forgot still gets the same picture
      expect(layoutGraph(m)).toEqual(base);
    }
    // Six dagre layouts: well under a second idle, over vitest's 5 s default on a saturated host.
  }, 15_000);

  it('returns zero size and nothing else for an empty model', () => {
    expect(layoutGraph(model([], []))).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it('lays out 75 nodes fast, each at its own position', () => {
    const ids = Array.from({ length: 75 }, (_, i) => `src/m${String(i).padStart(2, '0')}/file${i}.ts`);
    const pairs: [string, string][] = [];
    ids.forEach((id, i) => {
      for (const k of [1, 4, 11]) {
        const j = (i + k) % 75;
        if (j !== i) pairs.push([id, ids[j]!]);
      }
    });
    const t0 = performance.now();
    const l = layoutGraph(model(ids, pairs));
    // A busy runner takes 1-3 s; the bound is for a layout that blows up, not for a slow host.
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(l.nodes).toHaveLength(75);
    expect(new Set(l.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(75);
    expect(l.edges).toHaveLength(pairs.length);
  });
});
