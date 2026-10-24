import { describe, expect, it } from 'vitest';
import {
  announcement,
  detailOf,
  exampleOf,
  keepSelection,
  STRONGEST_SHOWN,
} from '@/client/connected/dialog/GraphDetail.js';
import {
  CHIPS_SHOWN,
  EMPTY_TEXT,
  LIST_CAP,
  chipsOf,
  listToggleLabel,
  visibleRows,
} from '@/client/connected/dialog/LinkList.js';
import type { GraphLayout, PlacedNode, RoutedEdge } from '@/client/connected/graph/layout.js';

const node = (id: string, extra: Partial<PlacedNode> = {}): PlacedNode => ({
  id,
  name: id,
  dir: '',
  status: 'modified',
  add: 0,
  del: 0,
  out: 0,
  in: 0,
  test: false,
  x: 0,
  y: 0,
  w: 148,
  h: 48,
  ...extra,
});
const edge = (from: string, to: string, weight = 1): RoutedEdge => ({
  id: `${from}\u0000${to}`,
  from,
  to,
  weight,
  uses: [],
  total: 0,
  context: false,
  points: [],
  label: { x: 0, y: 0 },
});

const layout: GraphLayout = {
  nodes: [node('a'), node('b'), node('c'), node('d')],
  edges: [edge('a', 'b', 1), edge('a', 'c', 4), edge('c', 'b', 2), edge('b', 'a', 2)],
  width: 0,
  height: 0,
};

describe('keepSelection', () => {
  it('keeps a node or arrow the layout holds and drops one it lost', () => {
    const arrow = { kind: 'edge', id: edge('a', 'b').id } as const;
    expect(keepSelection(layout, { kind: 'node', id: 'a' })).toEqual({ kind: 'node', id: 'a' });
    expect(keepSelection(layout, arrow)).toBe(arrow);
    expect(keepSelection(layout, { kind: 'node', id: 'zzz' })).toBeNull();
    expect(keepSelection(layout, { kind: 'edge', id: 'zzz' })).toBeNull();
    expect(keepSelection(layout, null)).toBeNull();
  });
});

describe('detailOf', () => {
  it('shows the strongest arrows first when nothing is selected', () => {
    const d = detailOf(layout, null);
    if (d.kind !== 'overview') throw new Error('expected the overview');
    expect(d.strongest.map((r) => `${r.from.id}>${r.to.id}`)).toEqual(['a>c', 'b>a', 'c>b', 'a>b']);
  });

  it('shows at most a handful of them', () => {
    const many: GraphLayout = {
      ...layout,
      nodes: Array.from({ length: 9 }, (_, i) => node(`n${i}`)),
      edges: Array.from({ length: 8 }, (_, i) => edge(`n${i}`, `n${i + 1}`, i)),
    };
    const d = detailOf(many, null);
    if (d.kind !== 'overview') throw new Error('expected the overview');
    expect(d.strongest).toHaveLength(STRONGEST_SHOWN);
    expect(d.strongest[0]!.edge.weight).toBe(7);
  });

  it('lists what a selected file uses and what uses it, strongest first', () => {
    const d = detailOf(layout, { kind: 'node', id: 'a' });
    if (d.kind !== 'node') throw new Error('expected a node');
    expect(d.node.id).toBe('a');
    expect(d.uses.map((r) => r.to.id)).toEqual(['c', 'b']);
    expect(d.usedBy.map((r) => r.from.id)).toEqual(['b']);
  });

  it('names both ends of a selected arrow', () => {
    const d = detailOf(layout, { kind: 'edge', id: edge('c', 'b').id });
    if (d.kind !== 'edge') throw new Error('expected an arrow');
    expect([d.link.from.id, d.link.to.id]).toEqual(['c', 'b']);
  });

  it('falls back to the overview for a selection the layout no longer has', () => {
    expect(detailOf(layout, { kind: 'node', id: 'zzz' }).kind).toBe('overview');
    expect(detailOf(layout, { kind: 'edge', id: 'zzz' }).kind).toBe('overview');
  });
});

describe('announcement', () => {
  it('says nothing without a selection', () => {
    expect(announcement(layout, null)).toBe('');
    expect(announcement(layout, { kind: 'node', id: 'gone' })).toBe('');
  });

  it('names a file with what it uses and what uses it', () => {
    expect(announcement(layout, { kind: 'node', id: 'a' })).toBe('a selected: uses 2 files, used by 1 file');
    expect(announcement(layout, { kind: 'node', id: 'd' })).toBe('d selected: uses 0 files, used by 0 files');
  });

  it('says an arrow as a sentence', () => {
    expect(announcement(layout, { kind: 'edge', id: edge('c', 'b').id })).toBe('Selected arrow: c uses b');
  });
});

describe('exampleOf', () => {
  it('reads the strongest arrow as a sentence, the worked example of the panel', () => {
    const d = detailOf(layout, null);
    if (d.kind !== 'overview') throw new Error('expected the overview');
    expect(exampleOf(d.strongest)).toBe('Example: a uses c');
  });

  it('is null when the graph has no arrow', () => {
    expect(exampleOf([])).toBeNull();
  });
});

describe('detailOf with test files', () => {
  // One file used by two sources and two tests, and using one source and one test; strengths are mixed on purpose.
  const mixed: GraphLayout = {
    nodes: [
      node('hub'),
      node('src/a'),
      node('src/b'),
      node('t/a_test', { test: true }),
      node('t/b_test', { test: true }),
      node('lib/x'),
      node('lib/x_test', { test: true }),
    ],
    edges: [
      edge('t/a_test', 'hub', 9),
      edge('src/a', 'hub', 2),
      edge('t/b_test', 'hub', 5),
      edge('src/b', 'hub', 3),
      edge('hub', 'lib/x_test', 8),
      edge('hub', 'lib/x', 1),
    ],
    width: 0,
    height: 0,
  };
  const hub = () => {
    const d = detailOf(mixed, { kind: 'node', id: 'hub' });
    if (d.kind !== 'node') throw new Error('expected a node');
    return d;
  };

  it('lists source callers before test callers, each group strongest first', () => {
    expect(hub().usedBy.map((r) => r.from.id)).toEqual(['src/b', 'src/a', 't/a_test', 't/b_test']);
  });

  it('lists the source files a file uses before its tests', () => {
    expect(hub().uses.map((r) => r.to.id)).toEqual(['lib/x', 'lib/x_test']);
  });

  it('breaks ties by arrow id and does not depend on the input order', () => {
    const tied: GraphLayout = { ...mixed, edges: mixed.edges.map((e) => ({ ...e, weight: 1 })) };
    const reversed: GraphLayout = { ...tied, edges: [...tied.edges].reverse() };
    const a = detailOf(tied, { kind: 'node', id: 'hub' });
    const b = detailOf(reversed, { kind: 'node', id: 'hub' });
    if (a.kind !== 'node' || b.kind !== 'node') throw new Error('expected a node');
    expect(a.usedBy.map((r) => r.from.id)).toEqual(['src/a', 'src/b', 't/a_test', 't/b_test']);
    expect(b.usedBy.map((r) => r.from.id)).toEqual(a.usedBy.map((r) => r.from.id));
  });

  it('keeps the overview strongest-first, tests and all', () => {
    const d = detailOf(mixed, null);
    if (d.kind !== 'overview') throw new Error('expected the overview');
    expect(d.strongest.map((r) => r.edge.weight)).toEqual([9, 8, 5, 3, 2]);
  });
});

describe('chipsOf', () => {
  const use = (symbol: string) => ({ symbol, kind: 12, path: 'p', lines: [1] });

  it('shows at most the first few symbols and counts exactly the rest', () => {
    const uses = ['a', 'b', 'c', 'd', 'e'].map(use);
    const c = chipsOf({ uses, total: 9 });
    expect(c.shown.map((u) => u.symbol)).toEqual(['a', 'b', 'c']);
    expect(c.more).toBe(6);
    expect(c.shown.length + c.more).toBe(9);
  });

  it('counts nothing more when every symbol fits', () => {
    expect(chipsOf({ uses: [use('a'), use('b')], total: 2 }).more).toBe(0);
    expect(chipsOf({ uses: ['a', 'b', 'c'].map(use), total: 3 })).toMatchObject({ more: 0 });
    expect(CHIPS_SHOWN).toBe(3);
  });

  it('never reports a negative count', () => {
    expect(chipsOf({ uses: [use('a')], total: 0 }).more).toBe(0);
  });
});

describe('visibleRows', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('shows every row up to the cap, with no disclosure', () => {
    expect(visibleRows(rows(LIST_CAP), false)).toEqual({ rows: rows(LIST_CAP), folded: 0 });
    expect(visibleRows(rows(2), false).folded).toBe(0);
  });

  it('folds the rows past the cap until the list is expanded', () => {
    const v = visibleRows(rows(9), false);
    expect(v.rows).toEqual(rows(LIST_CAP));
    expect(v.folded).toBe(3);
    expect(visibleRows(rows(9), true)).toEqual({ rows: rows(9), folded: 0 });
  });

  it('labels its one button with the whole count, then with fewer', () => {
    expect(listToggleLabel(9, false)).toBe('Show all 9');
    expect(listToggleLabel(9, true)).toBe('Show fewer');
  });
});

describe('empty text', () => {
  it('says why a list is empty, in plain words', () => {
    expect(EMPTY_TEXT).toEqual({ to: 'It uses nothing else drawn.', from: 'Nothing drawn uses it.' });
  });
});
