import { Fragment } from 'react';
import { kindColor, KindIcon } from '@/client/lsp/symbolKind.js';
import { isTest } from './filters.js';
import { arrowHead, Cluster, Node } from './GraphShapes.js';
import { useGraph } from './state.js';
import type { Box, Placed } from '@/client/graph/layout/layout.js';
import { edgeKey } from '@/client/graph/layout/rank.js';

/**
 * What stays lit: the selection, hovered node or focused file (`seeds`) and everything linked to
 * them (`ids`); with an arrow selected, `edge` names it and only it lights up.
 */
export interface Lit {
  ids: Set<string>;
  seeds: Set<string>;
  edge: string | null;
  /** Find's matches: drawn hinted, as the far end of a hovered details row is. */
  marks?: Set<string>;
  /** Find's query, trimmed and lower-cased, while it has matches. */
  query?: string;
}

/** The symbols behind a file view's arrow, which its label names, the most-used first. */
export interface EdgeLabel {
  symbols: { name: string; kind: number }[];
}

const FADED = 0.35;
const FADED_EDGE = 0.2;
/** On-screen width of an arrow's invisible hit stroke, whatever the zoom. */
const HIT_PX = 14;
const LABEL_NAMES = 2;
const LABEL_CHAR = 6.6;
const LABEL_H = 20;
const LABEL_GAP = 4;
/** Where along its arrow a label may sit, in order of preference: the middle, then toward either end. */
const LABEL_SPOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];

/** One placed part of the graph in its own coordinates: file boxes, arrows, symbols. */
export function GraphPart({
  placed,
  clustered,
  selected,
  lit,
  zoom,
  labels,
}: {
  placed: Placed;
  clustered: boolean;
  selected: string | null;
  lit: Lit | null;
  zoom: number;
  /** File view only: each arrow's symbols, by `edgeKey`. */
  labels: Map<string, EdgeLabel> | null;
}) {
  // The arrow of the details row under the pointer: drawn last, so on top, with its ends in full.
  const hovered = useGraph((s) => s.hoveredEdge);
  // The file picked in the tree: its boxes, and its frame in symbol view, take the accent.
  const focusPath = useGraph((s) => s.focusPath);
  const hot = placed.edges.find((e) => edgeKey(e.edge) === hovered)?.edge;
  const edges = hot
    ? [...placed.edges.filter((e) => e.edge !== hot), placed.edges.find((e) => e.edge === hot)!]
    : placed.edges;
  const opacity = (ids: string[]) =>
    lit && !ids.some((id) => lit.ids.has(id) || id === hot?.from || id === hot?.to) ? FADED : 1;
  const isOn = (key: string, from: string, to: string) =>
    !!lit && (lit.edge ? lit.edge === key : lit.seeds.has(from) || lit.seeds.has(to));
  // A file view's arrow labels, on the lit arrows only and over the boxes: every label at once
  // piles up where arrows run close. Each slides along its arrow to the first spot clear of the
  // labels before it and of the boxes, else to the one covering least; the hovered arrow's goes
  // first, so it keeps the middle.
  const taken: Box[] = [];
  const pills =
    labels &&
    [...edges].reverse().map(({ edge, along }) => {
      const key = edgeKey(edge);
      const label = labels.get(key);
      if (!label || !(edge === hot || isOn(key, edge.from, edge.to))) return null;
      const text = pillText(label);
      const w = text.length * LABEL_CHAR + 30;
      const spots = LABEL_SPOTS.map((t) => along(t)).map((p) => ({
        x: p.x - w / 2,
        y: p.y - LABEL_H / 2,
        w,
        h: LABEL_H,
      }));
      const cost = (r: Box) =>
        2 * taken.filter((o) => overlaps(r, o)).length + placed.nodes.filter((n) => overlaps(r, n)).length;
      const rect = spots.reduce((best, r) => (cost(r) < cost(best) ? r : best));
      taken.push(rect);
      return <Pill key={key} edgeKey={key} label={label} text={text} rect={rect} />;
    });
  return (
    <>
      {placed.clusters.map((c) => {
        const members = placed.nodes.filter((n) => n.node.path === c.path && within(n, c));
        return (
          <Cluster
            key={`${c.path}@${c.layer}@${c.x},${c.y}`}
            cluster={c}
            members={members}
            opacity={opacity(members.map((n) => n.node.id))}
            focused={c.path === focusPath}
          />
        );
      })}
      {edges.map(({ edge, d, back }) => {
        const key = edgeKey(edge);
        const isHot = edge === hot;
        const on = isHot || isOn(key, edge.from, edge.to);
        // A lit arrow is a step heavier than its weight, the details row's arrow two.
        const w = Math.min(3, width(edge.lines.length) + (isHot ? 2 : on ? 1 : 0));
        return (
          <g key={key} data-edge={key} className="cursor-pointer">
            <path d={d} fill="none" stroke="transparent" strokeWidth={HIT_PX / zoom} />
            <path
              d={d}
              fill="none"
              stroke={on ? 'var(--accent)' : 'var(--fg-2)'}
              // Opacity, not stroke-opacity: the arrowhead marker fades only with the whole path.
              opacity={isHot ? 1 : (lit && !on) || hot ? FADED_EDGE : on ? 0.95 : 0.5}
              strokeWidth={w}
              strokeDasharray={back ? '4 3' : undefined}
              markerEnd={arrowHead(w, on)}
            />
          </g>
        );
      })}
      {placed.nodes.map((p) => (
        <Node
          key={p.node.id}
          placed={p}
          clustered={clustered}
          focus={
            p.node.id === selected
              ? 'selected'
              : p.node.id === hot?.from ||
                  p.node.id === hot?.to ||
                  lit?.marks?.has(p.node.id) ||
                  p.node.path === focusPath
                ? 'hinted'
                : // Linked to the selection or the picked file, not merely to the box under the pointer.
                  (selected || focusPath) && !lit?.marks && lit?.ids.has(p.node.id) && !lit.seeds.has(p.node.id)
                  ? 'linked'
                  : null
          }
          opacity={opacity([p.node.id])}
          test={isTest(p.node)}
          mark={lit?.marks?.has(p.node.id) ? (lit.query ?? null) : null}
        />
      ))}
      {pills}
    </>
  );
}

/**
 * A file arrow's label: the used symbols' kind icon and full names, the first few and a count of
 * the rest. Opaque, so a faded line never shows through it.
 */
function Pill({
  edgeKey: key,
  label,
  text,
  rect: { x, y, w },
}: {
  edgeKey: string;
  label: EdgeLabel;
  text: string;
  rect: Box;
}) {
  return (
    <g data-edge={key} className="cursor-pointer">
      {label.symbols.length > LABEL_NAMES && <title>{label.symbols.map((s) => s.name).join(', ')}</title>}
      <rect x={x} y={y} width={w} height={LABEL_H} rx={LABEL_H / 2} fill="var(--bg-2)" stroke="var(--border)" />
      <KindIcon kind={label.symbols[0]!.kind} x={x + 7} y={y + 4} size={12} />
      {/* `text` is what was measured; each name takes its kind's color, as in the boxes. */}
      <text x={x + 23} y={y + 14} className="fill-foreground font-mono text-[11px]" aria-label={text}>
        {label.symbols.slice(0, LABEL_NAMES).map((s, i) => (
          <Fragment key={s.name}>
            {i > 0 && ', '}
            <tspan style={kindColor(s.kind) ? { fill: kindColor(s.kind) } : undefined}>{s.name}</tspan>
          </Fragment>
        ))}
        {label.symbols.length > LABEL_NAMES && ` +${label.symbols.length - LABEL_NAMES}`}
      </text>
    </g>
  );
}

function pillText(label: EdgeLabel): string {
  const shown = label.symbols
    .slice(0, LABEL_NAMES)
    .map((s) => s.name)
    .join(', ');
  const more = label.symbols.length - LABEL_NAMES;
  return more > 0 ? `${shown} +${more}` : shown;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w + LABEL_GAP &&
  b.x < a.x + a.w + LABEL_GAP &&
  a.y < b.y + b.h + LABEL_GAP &&
  b.y < a.y + a.h + LABEL_GAP;

/** An arrow's weight: one per reference line, up to three. */
const width = (lines: number) => Math.min(3, lines);

const within = (n: Box, c: Box) => n.x >= c.x && n.x < c.x + c.w && n.y >= c.y && n.y < c.y + c.h;
