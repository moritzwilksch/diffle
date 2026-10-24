import { describe, expect, it } from 'vitest';
import type { GraphUse } from '@/shared/protocol.js';
import type { GraphLayout, PlacedNode, RoutedEdge } from '@/client/connected/graph/layout.js';
import {
  EDGE_STAGGER_CAP,
  ENTRANCE_MAX_NODES,
  NODE_STAGGER_CAP,
  arrowHead,
  curvePath,
  edgeLabel,
  edgeTitle,
  fitText,
  graphSummary,
  hasEntrance,
  hiddenNote,
  highlight,
  isLit,
  keyAction,
  labelOffsets,
  MAX_LABEL_WIDTH,
  nodeLabel,
  sameSelection,
  staggerVar,
  strokeWidth,
  toggleSelection,
  trimEnd,
} from '@/client/connected/graph/view.js';
import {
  FIT_MAX_SCALE,
  FIT_MARGIN,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  clampScale,
  fitTransform,
  panIntoView,
  wheelFactor,
  zoomAt,
} from '@/client/connected/graph/viewport.js';

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
const edge = (from: string, to: string, extra: Partial<RoutedEdge> = {}): RoutedEdge => ({
  id: `${from}\u0000${to}`,
  from,
  to,
  weight: 1,
  uses: [],
  total: 0,
  context: false,
  points: [],
  label: { x: 0, y: 0 },
  ...extra,
});
const use = (symbol: string, lines: number[], kind = 12): GraphUse => ({ symbol, kind, path: 'a.py', lines });

describe('fitTransform', () => {
  it('centres content smaller than the viewport and caps the scale at 1.25', () => {
    const t = fitTransform({ width: 100, height: 100 }, { width: 1000, height: 800 });
    expect(t.k).toBe(FIT_MAX_SCALE);
    expect(t.x).toBeCloseTo((1000 - 100 * 1.25) / 2);
    expect(t.y).toBeCloseTo((800 - 100 * 1.25) / 2);
  });

  it('shrinks content to the tighter axis, keeping the margin on both sides', () => {
    const t = fitTransform({ width: 2000, height: 500 }, { width: 1000, height: 800 });
    expect(t.k).toBeCloseTo((1000 - 2 * FIT_MARGIN) / 2000);
    expect(t.x).toBeCloseTo(FIT_MARGIN);
    expect(t.y).toBeCloseTo((800 - 500 * t.k) / 2);
  });

  it('never goes below the minimum scale, and survives an empty or unmeasured box', () => {
    expect(fitTransform({ width: 1e6, height: 10 }, { width: 100, height: 100 }).k).toBe(MIN_SCALE);
    expect(fitTransform({ width: 0, height: 0 }, { width: 100, height: 100 }).k).toBe(FIT_MAX_SCALE);
    expect(fitTransform({ width: 10, height: 10 }, { width: 0, height: 0 }).k).toBe(MIN_SCALE);
  });
});

describe('zoom', () => {
  it('clamps the scale to its bounds', () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });

  it('keeps the content point under the cursor fixed', () => {
    const t = { x: 40, y: 30, k: 1 };
    const p = { x: 200, y: 150 };
    const z = zoomAt(t, 2, p);
    expect(z.k).toBe(2);
    // The content point that was under p is still under p.
    expect((p.x - z.x) / z.k).toBeCloseTo((p.x - t.x) / t.k);
    expect((p.y - z.y) / z.k).toBeCloseTo((p.y - t.y) / t.k);
  });

  it('returns the same transform at a bound, so no re-render follows', () => {
    const t = { x: 1, y: 2, k: MAX_SCALE };
    expect(zoomAt(t, 2, { x: 0, y: 0 })).toBe(t);
  });
});

describe('wheelFactor', () => {
  it('zooms in on a scroll up and out on a scroll down, symmetrically', () => {
    expect(wheelFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0)).toBeLessThan(1);
    expect(wheelFactor(100, 0) * wheelFactor(-100, 0)).toBeCloseTo(1);
    expect(wheelFactor(0, 0)).toBe(1);
  });

  it('counts a line notch as many pixels', () => {
    expect(wheelFactor(-3, 1)).toBeGreaterThan(wheelFactor(-3, 0));
  });
});

describe('panIntoView', () => {
  const viewport = { width: 400, height: 300 };
  const rect = { x: 100, y: 100, w: 100, h: 50 };

  it('leaves a visible rect alone', () => {
    const t = { x: 0, y: 0, k: 1 };
    expect(panIntoView(t, rect, viewport, 20)).toBe(t);
  });

  it('pans just enough to bring an off-screen rect inside the padding', () => {
    const t = panIntoView({ x: 0, y: 0, k: 1 }, { x: 500, y: 400, w: 100, h: 50 }, viewport, 20);
    expect(t.x).toBe(400 - 20 - 600);
    expect(t.y).toBe(300 - 20 - 450);
    const back = panIntoView({ x: 0, y: 0, k: 1 }, { x: -80, y: -40, w: 100, h: 50 }, viewport, 20);
    expect(back.x).toBe(20 + 80);
    expect(back.y).toBe(20 + 40);
  });

  it('accounts for the scale', () => {
    const t = panIntoView({ x: 0, y: 0, k: 2 }, { x: 200, y: 0, w: 100, h: 50 }, viewport, 0);
    expect(t.x).toBe(400 - 600);
  });
});

describe('curvePath', () => {
  const pt = (x: number, y: number) => ({ x, y });

  it('is empty for no points and a lone move for one', () => {
    expect(curvePath([])).toBe('');
    expect(curvePath([pt(3, 4)])).toBe('M3 4');
  });

  it('is a straight line for two points', () => {
    expect(curvePath([pt(0, 0), pt(10, 20)])).toBe('M0 0L10 20');
  });

  it('is one smooth cubic per segment through every point for three', () => {
    const d = curvePath([pt(0, 0), pt(60, 30), pt(120, 0)]);
    expect(d.startsWith('M0 0C')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d.endsWith('120 0')).toBe(true);
    expect(d).toContain('60 30');
  });

  it('handles many points and never emits NaN for coincident ones', () => {
    const many = Array.from({ length: 8 }, (_, i) => pt(i * 10, (i % 2) * 10));
    expect(curvePath(many).match(/C/g)).toHaveLength(7);
    expect(curvePath([pt(5, 5), pt(5, 5), pt(5, 5)])).not.toContain('NaN');
  });
});

describe('arrowhead', () => {
  it('puts the tip on the last point, pointing along the last segment', () => {
    const head = arrowHead(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 100, y: 0 },
      ],
      10,
    );
    expect(head.startsWith('100,0 ')).toBe(true);
    const [, a, b] = head.split(' ').map((p) => p.split(',').map(Number)) as number[][];
    expect(a![0]).toBeLessThan(100);
    expect(b![0]).toBeLessThan(100);
    expect(a![1]).toBeCloseTo(-b![1]!);
  });

  it('is empty without a direction', () => {
    expect(arrowHead([{ x: 1, y: 1 }], 10)).toBe('');
    expect(
      arrowHead(
        [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
        10,
      ),
    ).toBe('');
  });

  it('trims the end of the polyline back along its last segment', () => {
    expect(
      trimEnd(
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        10,
      ),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 90, y: 0 },
    ]);
  });

  it('does not trim past a segment shorter than the trim', () => {
    const short = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ];
    expect(trimEnd(short, 10)).toEqual(short);
  });
});

describe('strokeWidth', () => {
  it('grows with weight between 1.5 and 4', () => {
    expect(strokeWidth(1)).toBe(1.5);
    expect(strokeWidth(0)).toBe(1.5);
    expect(strokeWidth(3)).toBeGreaterThan(strokeWidth(2));
    expect(strokeWidth(100)).toBe(4);
  });
});

describe('highlight', () => {
  const layout: GraphLayout = {
    nodes: [node('a'), node('b'), node('c'), node('d')],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    width: 0,
    height: 0,
  };
  const ab = edge('a', 'b').id;
  const bc = edge('b', 'c').id;
  const ca = edge('c', 'a').id;

  it('lights everything when nothing is active', () => {
    const none = highlight(layout, null);
    expect(none).toBeNull();
    expect(isLit(none, 'node', 'd')).toBe(true);
    expect(isLit(none, 'edge', ab)).toBe(true);
  });

  it('lights a node, its neighbours and its incident arrows only', () => {
    const h = highlight(layout, { kind: 'node', id: 'a' });
    expect([...h!.nodes].sort()).toEqual(['a', 'b', 'c']);
    expect([...h!.edges].sort()).toEqual([ab, ca].sort());
    expect(isLit(h, 'node', 'd')).toBe(false);
    expect(isLit(h, 'edge', bc)).toBe(false);
  });

  it('lights an isolated node alone', () => {
    const h = highlight(layout, { kind: 'node', id: 'd' });
    expect([...h!.nodes]).toEqual(['d']);
    expect(h!.edges.size).toBe(0);
  });

  it('lights an arrow and its two ends only', () => {
    const h = highlight(layout, { kind: 'edge', id: bc });
    expect([...h!.nodes].sort()).toEqual(['b', 'c']);
    expect([...h!.edges]).toEqual([bc]);
  });

  it('lights just the arrow when the id is unknown', () => {
    const h = highlight(layout, { kind: 'edge', id: 'x' });
    expect(h!.nodes.size).toBe(0);
    expect([...h!.edges]).toEqual(['x']);
  });
});

describe('selection', () => {
  const a = { kind: 'node', id: 'a' } as const;

  it('compares by kind and id, null only to null', () => {
    expect(sameSelection(a, { kind: 'node', id: 'a' })).toBe(true);
    expect(sameSelection(a, { kind: 'edge', id: 'a' })).toBe(false);
    expect(sameSelection(a, { kind: 'node', id: 'b' })).toBe(false);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(a, null)).toBe(false);
  });

  it('toggles: selecting the selected item clears it', () => {
    expect(toggleSelection(null, a)).toEqual(a);
    expect(toggleSelection(a, a)).toBeNull();
    expect(toggleSelection(a, { kind: 'node', id: 'b' })).toEqual({ kind: 'node', id: 'b' });
  });
});

describe('text', () => {
  it('fits text to a width with an ellipsis', () => {
    expect(fitText('short', 100, 7)).toBe('short');
    expect(fitText('a-very-long-file-name.ts', 70, 7)).toBe('a-very-lo…');
    expect(fitText('abc', 0, 7)).toBe('…');
  });

  it('describes a node for a screen reader', () => {
    const changed = node('ledger.py', { name: 'ledger.py', status: 'modified', add: 18, del: 6, out: 1, in: 2 });
    expect(nodeLabel(changed)).toBe('ledger.py, modified, +18 -6, uses 1 file, used by 2 files');
    const context = node('app.py', { name: 'app.py', status: 'context', out: 1, in: 0 });
    expect(nodeLabel(context)).toBe('app.py, unchanged caller, uses 1 file, used by 0 files');
    const test = node('test_ledger.py', { name: 'test_ledger.py', test: true, add: 13, out: 3 });
    expect(nodeLabel(test)).toBe('test_ledger.py, test, modified, +13 -0, uses 3 files, used by 0 files');
  });

  it('labels an arrow with its first symbol and the rest as a count', () => {
    const one = edge('a', 'b', { uses: [use('post', [3])], total: 1 });
    expect(edgeLabel(one)).toMatchObject({ name: 'post', more: 0, kind: 12 });
    const many = edge('a', 'b', { uses: [use('post', [3]), use('get', [4])], total: 7 });
    expect(edgeLabel(many)).toMatchObject({ name: 'post', more: 6 });
    expect(edgeLabel(edge('a', 'b'))).toMatchObject({ name: '', more: 0, kind: null });
  });

  it('keeps a long symbol name inside the pill budget', () => {
    const long = edge('a', 'b', { uses: [use('averyveryverylongsymbolname', [3])], total: 3 });
    const label = edgeLabel(long);
    expect(label.name.endsWith('…')).toBe(true);
    expect(label.width).toBeGreaterThan(0);
  });

  it('never draws a pill wider than the room between two ranks leaves it', () => {
    const long = edge('a', 'b', { uses: [use('averyveryverylongsymbolname', [3])], total: 30 });
    expect(edgeLabel(long).width).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    expect(MAX_LABEL_WIDTH).toBeLessThanOrEqual(100);
  });

  it('moves the pills of a mutual pair apart, one above the middle and one below, and leaves the rest', () => {
    const forward = edge('a', 'b');
    const back = edge('b', 'a');
    const other = edge('a', 'c');
    const offsets = labelOffsets([forward, back, other]);
    expect(offsets.get(forward.id)).toBeLessThan(0);
    expect(offsets.get(back.id)).toBeGreaterThan(0);
    expect(offsets.has(other.id)).toBe(false);
  });

  it('moves a mutual pair apart from where their labels really are, keeping the upper one up', () => {
    const forward = edge('a', 'b', { label: { x: 50, y: 104 } });
    const back = edge('b', 'a', { label: { x: 50, y: 96 } });
    const offsets = labelOffsets([forward, back]);
    const y = (e: RoutedEdge) => e.label.y + (offsets.get(e.id) ?? 0);
    expect(y(back)).toBeLessThan(y(forward));
    expect(y(forward) - y(back)).toBeGreaterThanOrEqual(22);
    // The pair stays centred on where its labels were.
    expect((y(forward) + y(back)) / 2).toBe(100);
  });

  it('lists every use in the arrow title, with its lines', () => {
    const e = edge('a', 'b', { uses: [use('post', [12, 40]), use('Ledger', [], 5)], total: 4 });
    expect(edgeTitle(e)).toBe(
      'a uses post, Ledger and 2 more from b\npost (function) lines 12, 40\nLedger (class)\n+2 more',
    );
  });
});

describe('keyAction', () => {
  it('maps arrows and vim keys to the four steps', () => {
    expect(keyAction('ArrowRight')).toEqual({ type: 'step', dir: 'out' });
    expect(keyAction('l')).toEqual({ type: 'step', dir: 'out' });
    expect(keyAction('ArrowLeft')).toEqual({ type: 'step', dir: 'in' });
    expect(keyAction('h')).toEqual({ type: 'step', dir: 'in' });
    expect(keyAction('ArrowUp')).toEqual({ type: 'step', dir: 'up' });
    expect(keyAction('k')).toEqual({ type: 'step', dir: 'up' });
    expect(keyAction('ArrowDown')).toEqual({ type: 'step', dir: 'down' });
    expect(keyAction('j')).toEqual({ type: 'step', dir: 'down' });
  });

  it('maps Enter, Space, zoom and fit', () => {
    expect(keyAction('Enter')).toEqual({ type: 'open' });
    expect(keyAction(' ')).toEqual({ type: 'select' });
    expect(keyAction('+')).toEqual({ type: 'zoom', factor: ZOOM_STEP });
    expect(keyAction('=')).toEqual({ type: 'zoom', factor: ZOOM_STEP });
    expect(keyAction('-')).toEqual({ type: 'zoom', factor: 1 / ZOOM_STEP });
    expect(keyAction('0')).toEqual({ type: 'fit' });
    expect(keyAction('f')).toEqual({ type: 'fit' });
  });

  it('leaves Escape, Tab and everything else to the dialog and the browser', () => {
    for (const key of ['Escape', 'Tab', 'a', 'Shift', 'toString', 'constructor']) expect(keyAction(key)).toBeNull();
  });
});

describe('canvas wording', () => {
  it('summarises the drawn counts, then what was left out', () => {
    expect(graphSummary(1, 1, 0, 0)).toBe('Dependency graph: 1 file, 1 link');
    expect(graphSummary(4, 0, 2, 1)).toBe('Dependency graph: 4 files, 0 links; 2 files, 1 link not drawn');
    expect(graphSummary(4, 3, 0, 5)).toBe('Dependency graph: 4 files, 3 links; 5 links not drawn');
  });

  it('words the not-drawn note, omitting a part that is 0 and the note when both are', () => {
    expect(hiddenNote(0, 0)).toBeNull();
    expect(hiddenNote(3, 0)).toBe('+3 files not drawn');
    expect(hiddenNote(0, 1)).toBe('+1 link not drawn');
    expect(hiddenNote(3, 7)).toBe('+3 files, +7 links not drawn');
  });
});

describe('the entrance budget', () => {
  it('caps the stagger so late items do not wait', () => {
    expect(staggerVar('--i', 3, NODE_STAGGER_CAP)).toEqual({ '--i': 3 });
    expect(staggerVar('--i', 40, NODE_STAGGER_CAP)).toEqual({ '--i': NODE_STAGGER_CAP });
    expect(staggerVar('--n', 40, NODE_STAGGER_CAP)).toEqual({ '--n': NODE_STAGGER_CAP });
    expect(staggerVar('--i', 40, EDGE_STAGGER_CAP)).toEqual({ '--i': EDGE_STAGGER_CAP });
  });

  it('ends the last arrowhead within about 1.2 s', () => {
    // graph.css: node/edge stagger 40 ms, edges start half a `fast` (125 ms) after the nodes,
    // draw 400 ms but the head waits `medium` (350 ms) and then fades 150 ms.
    const end = NODE_STAGGER_CAP * 40 + 125 + EDGE_STAGGER_CAP * 40 + 350 + 150;
    expect(end).toBeLessThanOrEqual(1200);
  });

  it('skips the entrance for a big graph', () => {
    expect(hasEntrance(ENTRANCE_MAX_NODES)).toBe(true);
    expect(hasEntrance(ENTRANCE_MAX_NODES + 1)).toBe(false);
    expect(hasEntrance(0)).toBe(true);
  });
});
