import type { CSSProperties } from 'react';
import type { Dir } from './nav.js';
import type { GraphLayout, PlacedNode, Point, RoutedEdge } from './layout.js';
import { STATUS, kindGlyph } from './glyphs.js';
import { arrowSentence, plural } from '@/client/connected/clusters/copy.js';
import { ZOOM_STEP, clamp } from './viewport.js';

/** What the canvas has selected: a file, an arrow, or nothing. Controlled by the parent. */
export type Selection = { kind: 'node' | 'edge'; id: string } | null;

// Entrance budget (delays and durations in graph.css): the last arrowhead ends at
// NODE_STAGGER_CAP*40 + 125 + EDGE_STAGGER_CAP*40 + 350 + 150 = 1185 ms, however big the graph.
/** Nodes that stagger in; later ones enter with the last one's delay. Also the wait before the arrows. */
export const NODE_STAGGER_CAP = 8;
export const EDGE_STAGGER_CAP = 6;
/** A bigger graph appears at once: dozens of animated groups cost more than the entrance is worth. */
export const ENTRANCE_MAX_NODES = 20;

const MIN_STROKE = 1.5;
const MAX_STROKE = 4;
const STROKE_PER_WEIGHT = 0.5;
const CURVE_TENSION = 6;
const ARROW_SPREAD = 0.5;
/** Mono 11px advance; the pill is sized from it, so no DOM measuring is needed. */
const LABEL_CHAR_WIDTH = 6.6;
const LABEL_PAD = 7;
const LABEL_ICON = 12;
const LABEL_GAP = 4;
/** Symbol name plus `+N` stay within this many characters: the pill fits the 120px gap between two ranks. */
const LABEL_CHARS = 10;
/** The widest pill: a dozen pixels of the gap stay free on each side for the arrowhead. */
export const MAX_LABEL_WIDTH = 2 * LABEL_PAD + LABEL_ICON + LABEL_GAP + LABEL_CHARS * LABEL_CHAR_WIDTH;
/** How far a mutual pair's pills move off the middle, so neither covers the other. */
const PAIR_LABEL_OFFSET = 11;

const num = (v: number): string => String(Math.round(v * 10) / 10);

/**
 * A smooth path through every point: a straight line for two, a Catmull-Rom spline as cubic segments for more.
 * Empty for no points.
 */
export function curvePath(points: readonly Point[]): string {
  const first = points[0];
  if (!first) return '';
  let d = `M${num(first.x)} ${num(first.y)}`;
  if (points.length === 1) return d;
  if (points.length === 2) return `${d}L${num(points[1]!.x)} ${num(points[1]!.y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const c1 = { x: p1.x + (p2.x - p0.x) / CURVE_TENSION, y: p1.y + (p2.y - p0.y) / CURVE_TENSION };
    const c2 = { x: p2.x - (p3.x - p1.x) / CURVE_TENSION, y: p2.y - (p3.y - p1.y) / CURVE_TENSION };
    d += `C${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(p2.x)} ${num(p2.y)}`;
  }
  return d;
}

/** The unit direction of the last non-degenerate segment, or null when the polyline has none. */
function endDirection(points: readonly Point[]): Point | null {
  for (let i = points.length - 1; i > 0; i--) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) return { x: dx / len, y: dy / len };
  }
  return null;
}

/** The arrowhead as SVG `points` (tip first): the tip on the last point, `size` long, pointing along the line. */
export function arrowHead(points: readonly Point[], size: number): string {
  const tip = points[points.length - 1];
  const dir = endDirection(points);
  if (!tip || !dir) return '';
  const base = { x: tip.x - dir.x * size, y: tip.y - dir.y * size };
  const side = { x: -dir.y * size * ARROW_SPREAD, y: dir.x * size * ARROW_SPREAD };
  return [tip, { x: base.x + side.x, y: base.y + side.y }, { x: base.x - side.x, y: base.y - side.y }]
    .map((p) => `${num(p.x)},${num(p.y)}`)
    .join(' ');
}

/** Moves the polyline's end back by `by` along its last segment, so a thick line does not poke through the head. */
export function trimEnd(points: readonly Point[], by: number): Point[] {
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  if (!last || !prev) return [...points];
  const len = Math.hypot(last.x - prev.x, last.y - prev.y);
  if (len <= by) return [...points];
  const f = (len - by) / len;
  return [...points.slice(0, -1), { x: prev.x + (last.x - prev.x) * f, y: prev.y + (last.y - prev.y) * f }];
}

/** Arrow thickness: grows with the number of symbol pairs behind it. */
export function strokeWidth(weight: number): number {
  return clamp(1 + weight * STROKE_PER_WEIGHT, MIN_STROKE, MAX_STROKE);
}

export const sameSelection = (a: Selection, b: Selection): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id);

/** Selecting what is already selected clears it. */
export const toggleSelection = (current: Selection, next: Selection): Selection =>
  sameSelection(current, next) ? null : next;

/** What stays at full strength while something is hovered or selected. */
export interface Highlight {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

/** A node lights itself, its direct neighbours and its arrows; an arrow itself and its two ends; null lights all. */
export function highlight(layout: GraphLayout, active: Selection): Highlight | null {
  if (!active) return null;
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (active.kind === 'node') {
    nodes.add(active.id);
    for (const e of layout.edges) {
      if (e.from !== active.id && e.to !== active.id) continue;
      edges.add(e.id);
      nodes.add(e.from);
      nodes.add(e.to);
    }
  } else {
    edges.add(active.id);
    const e = layout.edges.find((x) => x.id === active.id);
    if (e) {
      nodes.add(e.from);
      nodes.add(e.to);
    }
  }
  return { nodes, edges };
}

export const isLit = (h: Highlight | null, kind: 'node' | 'edge', id: string): boolean =>
  h === null || (kind === 'node' ? h.nodes : h.edges).has(id);

/** `text` cut to fit `maxPx` at `charPx` per character, ending in an ellipsis when cut. */
export function fitText(text: string, maxPx: number, charPx: number): string {
  const max = Math.floor(maxPx / charPx);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** The label read to a screen reader, e.g. "ledger.py, modified, +18 -6, uses 1 file, used by 2 files". */
export function nodeLabel(n: PlacedNode): string {
  const parts = [n.name, ...(n.test ? ['test'] : []), STATUS[n.status].label.toLowerCase()];
  if (n.status !== 'context') parts.push(`+${n.add} -${n.del}`);
  parts.push(`uses ${plural(n.out, 'file')}`, `used by ${plural(n.in, 'file')}`);
  return parts.join(', ');
}

/** What an arrow's label pill shows: the first symbol, how many more, its kind, and its drawn width. */
export interface EdgeLabel {
  name: string;
  /** Symbols beyond the first. */
  more: number;
  /** LSP SymbolKind of the first symbol; null when the arrow names none. */
  kind: number | null;
  width: number;
}

export function edgeLabel(e: RoutedEdge): EdgeLabel {
  const first = e.uses[0];
  const more = first ? Math.max(0, e.total - 1) : 0;
  const moreChars = more > 0 ? `+${more}`.length + 1 : 0;
  const name = first ? fitText(first.symbol, (LABEL_CHARS - moreChars) * LABEL_CHAR_WIDTH, LABEL_CHAR_WIDTH) : '';
  const chars = name.length + moreChars;
  const icon = first ? LABEL_ICON + LABEL_GAP : 0;
  return { name, more, kind: first?.kind ?? null, width: 2 * LABEL_PAD + icon + chars * LABEL_CHAR_WIDTH };
}

/**
 * A vertical offset for the labels of each mutual pair of arrows, so the two pills end up `2 * PAIR_LABEL_OFFSET`
 * apart around the middle of where they were: the router may already have put one above the other, and a fixed
 * push could then cross them. The upper one (ties: the lower id) stays up.
 */
export function labelOffsets(edges: readonly RoutedEdge[]): Map<string, number> {
  const byId = new Map(edges.map((e) => [e.id, e]));
  const offsets = new Map<string, number>();
  for (const e of edges) {
    const twin = byId.get(`${e.to}\u0000${e.from}`);
    if (e.from === e.to || !twin || e.from > e.to) continue;
    const [upper, lower] =
      e.label.y < twin.label.y || (e.label.y === twin.label.y && e.from < e.to) ? [e, twin] : [twin, e];
    const middle = (upper.label.y + lower.label.y) / 2;
    offsets.set(upper.id, middle - PAIR_LABEL_OFFSET - upper.label.y);
    offsets.set(lower.id, middle + PAIR_LABEL_OFFSET - lower.label.y);
  }
  return offsets;
}

/** The hover text of an arrow: who uses whom, then each symbol with its kind and lines, in full. */
export function edgeTitle(e: RoutedEdge): string {
  const rows = e.uses.map((u) => {
    const lines = u.lines.length > 0 ? ` lines ${u.lines.join(', ')}` : '';
    return `${u.symbol} (${kindGlyph(u.kind).label})${lines}`;
  });
  const left = e.total - e.uses.length;
  return [arrowSentence(e), ...rows, ...(left > 0 ? [`+${left} more`] : [])].join('\n');
}

/** What a key does on a focused node. Escape is absent on purpose: the dialog closes on it. */
export type KeyAction =
  | { type: 'step'; dir: Dir }
  | { type: 'open' }
  | { type: 'select' }
  | { type: 'zoom'; factor: number }
  | { type: 'fit' };

const KEY_ACTIONS = new Map<string, KeyAction>([
  ['ArrowRight', { type: 'step', dir: 'out' }],
  ['l', { type: 'step', dir: 'out' }],
  ['ArrowLeft', { type: 'step', dir: 'in' }],
  ['h', { type: 'step', dir: 'in' }],
  ['ArrowUp', { type: 'step', dir: 'up' }],
  ['k', { type: 'step', dir: 'up' }],
  ['ArrowDown', { type: 'step', dir: 'down' }],
  ['j', { type: 'step', dir: 'down' }],
  ['Enter', { type: 'open' }],
  [' ', { type: 'select' }],
  ['+', { type: 'zoom', factor: ZOOM_STEP }],
  ['=', { type: 'zoom', factor: ZOOM_STEP }],
  ['-', { type: 'zoom', factor: 1 / ZOOM_STEP }],
  ['0', { type: 'fit' }],
  ['f', { type: 'fit' }],
]);

export const keyAction = (key: string): KeyAction | null => KEY_ACTIONS.get(key) ?? null;

/** The group's accessible name: what is drawn, then what the caps left out. */
export function graphSummary(files: number, links: number, hiddenFiles: number, hiddenLinks: number): string {
  const drawn = `Dependency graph: ${plural(files, 'file')}, ${plural(links, 'link')}`;
  const hidden = [hiddenFiles > 0 && plural(hiddenFiles, 'file'), hiddenLinks > 0 && plural(hiddenLinks, 'link')]
    .filter(Boolean)
    .join(', ');
  return hidden ? `${drawn}; ${hidden} not drawn` : drawn;
}

/** "+3 files, +7 links not drawn", leaving out a part that is 0; null when nothing was left out. */
export function hiddenNote(hiddenFiles: number, hiddenLinks: number): string | null {
  const parts = [
    hiddenFiles > 0 && `+${plural(hiddenFiles, 'file')}`,
    hiddenLinks > 0 && `+${plural(hiddenLinks, 'link')}`,
  ];
  const note = parts.filter(Boolean).join(', ');
  return note ? `${note} not drawn` : null;
}

/** Read to a screen reader after the group's name. */
export const KEYS_HELP =
  'Arrow keys or h j k l move between files, Enter opens the file, Space selects it, plus and minus zoom, 0 or f fits the view.';

const pointsKey = (points: readonly Point[]): string => points.map((p) => `${p.x},${p.y}`).join(' ');

/** React keys that change when an arrow's geometry does: a path cannot ease, so a moved arrow is new and draws on again. */
export const lineKey = (e: RoutedEdge): string => `${e.id}|${pointsKey(e.points)}`;
export const labelKey = (e: RoutedEdge): string => `${e.id}|${e.label.x},${e.label.y}`;

/** Whether a graph of `nodes` nodes plays its entrance. */
export const hasEntrance = (nodes: number): boolean => nodes <= ENTRANCE_MAX_NODES;

/** A stagger index as a CSS variable (`--i` for an item, `--n` for the count), capped so late items do not wait long. */
export const staggerVar = (name: '--i' | '--n', index: number, cap: number): CSSProperties => ({
  [name]: Math.min(index, cap),
});
