import { useMemo } from 'react';
import { KindIcon } from '@/client/lsp/symbolKind.js';
import { isTest } from './filters.js';
import { Cluster, Node } from './GraphShapes.js';
import type { Box, Placed } from './layout.js';
import { edgeKey } from './rank.js';

/**
 * What stays lit: the selection, hovered node or focused file (`seeds`) and everything linked to
 * them (`ids`); with an arrow selected, `edge` names it and only it lights up.
 */
export interface Lit {
  ids: Set<string>;
  seeds: Set<string>;
  edge: string | null;
}

/** What a file view's arrow carries: the symbols it uses there. */
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
  const opacity = (ids: string[]) => (lit && !ids.some((id) => lit.ids.has(id)) ? FADED : 1);
  const isOn = (key: string, from: string, to: string) =>
    !!lit && (lit.edge ? lit.edge === key : lit.seeds.has(from) || lit.seeds.has(to));
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
      {placed.edges.map(({ edge, d, back }) => {
        const key = edgeKey(edge);
        const on = isOn(key, edge.from, edge.to);
        return (
          <g key={key} data-edge={key} className="cursor-pointer">
            <path d={d} fill="none" stroke="transparent" strokeWidth={HIT_PX / zoom} />
            <path
              d={d}
              fill="none"
              stroke={on ? 'var(--accent)' : 'var(--fg-2)'}
              strokeOpacity={lit && !on ? FADED_EDGE : on ? 0.95 : 0.5}
              strokeWidth={1 + Math.min(2, Math.log2(edge.lines.length))}
              strokeDasharray={back ? '4 3' : undefined}
              markerEnd={on ? 'url(#graph-arrow-lit)' : 'url(#graph-arrow)'}
            />
          </g>
        );
      })}
      {labels &&
        placed.edges.map(({ edge, mid }) => {
          const key = edgeKey(edge);
          const label = labels.get(key);
          if (!label) return null;
          return (
            <Pill
              key={key}
              edgeKey={key}
              label={label}
              x={mid.x}
              y={mid.y}
              dim={!!lit && !isOn(key, edge.from, edge.to)}
            />
          );
        })}
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

const within = (n: Box, c: Box) => n.x >= c.x && n.x < c.x + c.w && n.y >= c.y && n.y < c.y + c.h;
