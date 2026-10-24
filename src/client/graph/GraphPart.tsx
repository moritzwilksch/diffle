import { Cluster, Node } from './GraphShapes.js';
import type { Box, Placed } from './layout.js';

/** What stays lit: the selection or the focused file (`seeds`), and everything linked to them (`ids`). */
export interface Lit {
  ids: Set<string>;
  seeds: Set<string>;
}

const FADED = 0.18;
export const HEAD = 44;

/** One placed part of the graph in its own coordinates: layer labels, file boxes, arrows, symbols. */
export function GraphPart({
  placed,
  clustered,
  selected,
  lit,
}: {
  placed: Placed;
  clustered: boolean;
  selected: string | null;
  lit: Lit | null;
}) {
  const opacity = (ids: string[]) => (lit && !ids.some((id) => lit.ids.has(id)) ? FADED : 1);
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
            opacity={opacity(members.map((n) => n.node.id)) === 1 ? 1 : 0.25}
          />
        );
      })}
      {placed.edges.map(({ edge, d, back }) => {
        const on = !!lit && (lit.seeds.has(edge.from) || lit.seeds.has(edge.to));
        return (
          <path
            key={`${edge.from}>${edge.to}`}
            d={d}
            fill="none"
            stroke={on ? 'var(--accent)' : 'var(--fg-2)'}
            strokeOpacity={lit && !on ? 0.12 : on ? 0.95 : 0.5}
            strokeWidth={1 + Math.min(2, Math.log2(edge.lines.length))}
            strokeDasharray={back ? '4 3' : undefined}
            markerEnd={on ? 'url(#graph-arrow-lit)' : 'url(#graph-arrow)'}
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
        />
      ))}
    </>
  );
}

const within = (n: Box, c: Box) => n.x >= c.x && n.x < c.x + c.w && n.y >= c.y && n.y < c.y + c.h;
