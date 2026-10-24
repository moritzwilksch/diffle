import { useMemo } from 'react';
import { KindIcon } from '@/client/lsp/symbolKind.js';
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
}

/** The symbols behind a file view's arrow, which its label names. */
export interface EdgeLabel {
  kind: number;
  names: string[];
}

const FADED = 0.35;
const FADED_EDGE = 0.2;
export const HEAD = 44;
/** On-screen width of an arrow's invisible hit stroke, whatever the zoom. */
const HIT_PX = 14;
const LABEL_NAMES = 2;
const LABEL_CHAR = 6.6;

/** One placed part of the graph in its own coordinates: layer labels, file boxes, arrows, symbols. */
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
  const degrees = useMemo(() => {
    const d = new Map<string, { in: number; out: number }>();
    const of = (id: string) => d.get(id) ?? d.set(id, { in: 0, out: 0 }).get(id)!;
    for (const { edge } of placed.edges) {
      of(edge.from).out++;
      of(edge.to).in++;
    }
    return d;
  }, [placed]);
  // The arrow of the details row under the pointer: drawn last, so on top, with its ends in full.
  const hovered = useGraph((s) => s.hoveredEdge);
  const hot = placed.edges.find((e) => edgeKey(e.edge) === hovered)?.edge;
  const edges = hot
    ? [...placed.edges.filter((e) => e.edge !== hot), placed.edges.find((e) => e.edge === hot)!]
    : placed.edges;
  const opacity = (ids: string[]) =>
    lit && !ids.some((id) => lit.ids.has(id) || id === hot?.from || id === hot?.to) ? FADED : 1;
  const isOn = (key: string, from: string, to: string) =>
    !!lit && (lit.edge ? lit.edge === key : lit.seeds.has(from) || lit.seeds.has(to));
  // A file view's arrow labels: the unlit ones under the boxes, the lit ones (`on`) over them.
  const pills = (on: boolean) =>
    labels &&
    placed.edges.map(({ edge, mid }) => {
      const key = edgeKey(edge);
      const label = labels.get(key);
      const shown = isOn(key, edge.from, edge.to);
      if (!label || shown !== on) return null;
      return <Pill key={key} edgeKey={key} label={label} x={mid.x} y={mid.y} dim={!!lit && !shown} />;
    });
  return (
    <>
      {placed.layers.length > 1 &&
        placed.layers.map((l, i) => (
          <text key={i} x={-HEAD} y={l.y + 16} textAnchor="end" className="fill-muted font-sans text-[11px]">
            {i === 0 ? 'entry' : i === placed.layers.length - 1 ? 'core' : ''}
          </text>
        ))}
      {placed.shelf != null && (
        <text x={0} y={placed.shelf - 12} className="fill-muted font-sans text-[11px]">
          No links to other changes or their users
        </text>
      )}
      {placed.clusters.map((c) => {
        const members = placed.nodes.filter((n) => n.node.path === c.path && within(n, c));
        return (
          <Cluster
            key={`${c.path}@${c.layer}@${c.x},${c.y}`}
            cluster={c}
            members={members}
            opacity={opacity(members.map((n) => n.node.id))}
          />
        );
      })}
      {edges.map(({ edge, d, back }) => {
        const key = edgeKey(edge);
        const isHot = edge === hot;
        const on = isHot || isOn(key, edge.from, edge.to);
        return (
          <g key={key} data-edge={key} className="cursor-pointer">
            <path d={d} fill="none" stroke="transparent" strokeWidth={HIT_PX / zoom} />
            <path
              d={d}
              fill="none"
              stroke={on ? 'var(--accent)' : 'var(--fg-2)'}
              // Opacity, not stroke-opacity: the arrowhead marker fades only with the whole path.
              opacity={isHot ? 1 : (lit && !on) || hot ? FADED_EDGE : on ? 0.95 : 0.5}
              strokeWidth={width(edge.lines.length) + (isHot ? 1.5 : 0)}
              strokeDasharray={back ? '4 3' : undefined}
              markerEnd={arrowHead(Math.min(3, width(edge.lines.length) + (isHot ? 1 : 0)), on)}
            />
          </g>
        );
      })}
      {pills(false)}
      {placed.nodes.map((p) => (
        <Node
          key={p.node.id}
          placed={p}
          clustered={clustered}
          selected={p.node.id === selected}
          opacity={opacity([p.node.id])}
          test={isTest(p.node)}
          degree={degrees.get(p.node.id) ?? { in: 0, out: 0 }}
        />
      ))}
      {/* Lit labels over the boxes, so a selected arrow's label reads in full where it crosses one. */}
      {pills(true)}
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
  x,
  y,
  dim,
}: {
  edgeKey: string;
  label: EdgeLabel;
  x: number;
  y: number;
  dim: boolean;
}) {
  const shown = label.names.slice(0, LABEL_NAMES).join(', ');
  const more = label.names.length - LABEL_NAMES;
  const text = more > 0 ? `${shown} +${more}` : shown;
  const w = text.length * LABEL_CHAR + 30;
  return (
    <g data-edge={key} className="cursor-pointer" opacity={dim ? 0.55 : 1}>
      <title>{label.names.join(', ')}</title>
      <rect x={x - w / 2} y={y - 10} width={w} height={20} rx={10} fill="var(--bg-2)" stroke="var(--border)" />
      <KindIcon kind={label.kind} x={x - w / 2 + 7} y={y - 6} size={12} color="var(--fg-2)" />
      <text x={x - w / 2 + 23} y={y + 4} className="fill-foreground font-mono text-[11px]">
        {text}
      </text>
    </g>
  );
}

/** An arrow's weight: one per reference line, up to three. */
const width = (lines: number) => Math.min(3, lines);

const within = (n: Box, c: Box) => n.x >= c.x && n.x < c.x + c.w && n.y >= c.y && n.y < c.y + c.h;
