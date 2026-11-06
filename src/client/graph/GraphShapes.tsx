import { FileCode2, Pencil, Plus } from 'lucide-react';
import { kindColor, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { Marked, useFindHits } from './GraphFind.js';
import { basename, clip, CODE_CHAR, dirname, KIND_CHAR, nodeLabel, SEPARATOR_W, TITLE_CHAR } from './labels.js';
import { CLUSTER_HEADER, type PlacedCluster, type PlacedNode } from '@/client/graph/layout/layout.js';

const STATUS_STROKE: Record<GraphNode['status'], string> = {
  added: 'var(--add)',
  modified: 'var(--accent)',
  consumer: 'var(--border)',
};

// The file header's monospace character width, to clip its path to the box.
const HEADER_CHAR = 6.9;

/** The canvas grey, also under a dependents-only file so its dots stop at the dashed outline. */
export const CANVAS_BG = 'color-mix(in srgb, var(--fg) 2.5%, var(--bg))';

/**
 * A file's box in one column: the file icon and its path as everywhere in diffle, dim directories and
 * a bold name. `focused`, the file picked in the tree, takes the accent.
 */
export function Cluster({
  cluster,
  members,
  opacity,
  focused,
}: {
  cluster: PlacedCluster;
  members: PlacedNode[];
  opacity: number;
  focused: boolean;
}) {
  const unchanged = members.every((n) => n.node.status === 'consumer');
  const room = Math.floor((cluster.w - 34) / HEADER_CHAR);
  const name = clip(basename(cluster.path), room);
  const dir = dirname(cluster.path);
  // The directory gives way first, from its start, so the nearest folders stay.
  const dirRoom = room - name.length - 1;
  const shownDir = !dir || dirRoom < 4 ? '' : dir.length + 1 > dirRoom ? `…${dir.slice(-(dirRoom - 2))}/` : `${dir}/`;
  return (
    <g opacity={opacity}>
      {`${shownDir}${name}` !== cluster.path && <title>{cluster.path}</title>}
      <rect
        x={cluster.x}
        y={cluster.y}
        width={cluster.w}
        height={cluster.h}
        rx={9}
        // A changed file is a plain panel under its symbol cards, a hairline off the grey canvas; an
        // unchanged one only dependents live in keeps the dashed outline that marks them, over the
        // canvas without its dots.
        fill={focused ? 'color-mix(in srgb, var(--accent) 5%, var(--bg))' : unchanged ? CANVAS_BG : 'var(--bg)'}
        stroke={
          focused ? 'var(--accent)' : unchanged ? 'var(--border)' : 'color-mix(in srgb, var(--border) 70%, transparent)'
        }
        strokeWidth={focused ? 1.5 : 1}
        strokeDasharray={unchanged ? '5 4' : undefined}
      />
      <FileCode2 x={cluster.x + 9} y={cluster.y + 7} size={13} color="var(--fg-2)" />
      <text x={cluster.x + 27} y={cluster.y + CLUSTER_HEADER / 2 + 4} className="font-mono text-[11.5px]">
        {shownDir && <tspan className="fill-muted">{shownDir}</tspan>}
        <tspan className={unchanged ? 'fill-muted' : 'fill-foreground'} fontWeight={600}>
          {name}
        </tspan>
      </text>
    </g>
  );
}

const STATUS_BADGE: Partial<Record<GraphNode['status'], { icon: typeof Plus; color: string }>> = {
  added: { icon: Plus, color: 'var(--add)' },
  modified: { icon: Pencil, color: 'var(--accent)' },
};

/**
 * How a box stands out: the selection; more lightly a find match, the picked file, or the far end of
 * a hovered details row; lightest a box linked to the selection.
 */
export type Focus = 'selected' | 'hinted' | 'linked';

const FOCUS: Record<Focus, { fill: string; stroke: string; width: number }> = {
  selected: { fill: 'color-mix(in srgb, var(--accent) 12%, var(--bg-card))', stroke: 'var(--accent)', width: 2.5 },
  hinted: { fill: 'color-mix(in srgb, var(--accent) 6%, var(--bg-card))', stroke: 'var(--accent)', width: 1.5 },
  linked: {
    fill: 'color-mix(in srgb, var(--accent) 3%, var(--bg-card))',
    stroke: 'color-mix(in srgb, var(--accent) 45%, var(--border))',
    width: 1.5,
  },
};

/**
 * A symbol: its kind's icon and colour, its name in monospace, what it is under it, and its change
 * as a badge (an icon besides the colour). A test recedes: quieter fill and name, and a `test` tag.
 * `focus` marks the selection, or more lightly the far end of the details row under the pointer.
 * `mark` is find's query while the box matches it: its occurrences are painted as the diff paints
 * search hits, the selected box's as the current one.
 */
export function Node({
  placed,
  clustered,
  focus,
  opacity,
  test,
  mark,
}: {
  placed: PlacedNode;
  clustered: boolean;
  focus: Focus | null;
  opacity: number;
  test: boolean;
  mark: string | null;
}) {
  const { node, x, y, w, h } = placed;
  const { title, kind, code } = nodeLabel(node, clustered);
  // The code part takes what room the kind leaves on its line.
  const codeRoom = w - 34 - (test ? 30 : 0) - kind.length * KIND_CHAR - (kind && code ? SEPARATOR_W : 0);
  const quiet = node.status === 'consumer' || test;
  const badge = STATUS_BADGE[node.status];
  const nameColor = kindColor(node.kind);
  const shownTitle = clip(title, Math.floor((w - 56) / TITLE_CHAR));
  const shownCode = clip(code, Math.floor(codeRoom / CODE_CHAR));
  const current = focus === 'selected';
  const [group, hits] = useFindHits(mark && `${mark}\0${shownTitle}\0${shownCode}\0${x},${y}`);
  return (
    <g
      ref={group}
      data-node={node.id}
      data-selected={focus === 'selected' || undefined}
      data-focus={focus ?? undefined}
      opacity={opacity}
      className="cursor-pointer"
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        // Focus takes the box itself, an accent border over a light accent fill; the badge keeps the
        // change status in view.
        fill={focus ? FOCUS[focus].fill : quiet ? 'var(--bg)' : 'var(--bg-card)'}
        stroke={
          focus
            ? FOCUS[focus].stroke
            : test && node.status !== 'consumer'
              ? 'var(--border)'
              : STATUS_STROKE[node.status]
        }
        strokeWidth={focus ? FOCUS[focus].width : quiet ? 1 : 1.5}
        // An unchanged file stays dashed under focus too, its dashes stretched to the wider stroke.
        strokeDasharray={node.status === 'consumer' && !clustered ? (focus === 'selected' ? '7 4' : '4 3') : undefined}
      />
      <KindIcon kind={node.kind} x={x + 7} y={y + 7} size={14} opacity={quiet ? 0.6 : 1} />
      {hits.map((b) => (
        <rect
          key={`${b.x},${b.y}`}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={2}
          fill={current ? 'var(--search-current)' : 'var(--search-match)'}
        />
      ))}
      <text
        x={x + 26}
        y={y + 18}
        className={`font-mono text-[12px] ${quiet ? 'fill-muted' : 'fill-foreground'}`}
        // A quiet box keeps its name muted, as it keeps its icon faded.
        style={quiet || !nameColor ? undefined : { fill: nameColor }}
      >
        <Marked text={shownTitle} query={mark} current={current} />
      </text>
      <text x={x + 26} y={y + 32} className="fill-muted font-sans text-[10.5px]">
        {test && <tspan className="fill-foreground font-semibold">test · </tspan>}
        {kind}
        {kind && code && ' · '}
        {code && (
          <tspan className="font-mono">
            <Marked text={shownCode} query={mark} current={current} />
          </tspan>
        )}
      </text>
      {badge && (
        <g>
          <rect
            x={x + w - 22}
            y={y + 5}
            width={16}
            height={16}
            rx={4}
            fill={`color-mix(in srgb, ${badge.color} 15%, transparent)`}
          />
          <badge.icon x={x + w - 19} y={y + 8} size={10} color={badge.color} strokeWidth={2.5} />
        </g>
      )}
    </g>
  );
}

/** Stroke widths an arrow is drawn in; each has its own head, sized to it. */
export const ARROW_WIDTHS = [1, 2, 3] as const;

/** The arrowhead for a stroke of `width`, muted or lit. */
export const arrowHead = (width: number, lit: boolean) => `url(#graph-arrow-${width}${lit ? '-lit' : ''})`;

/** Arrowheads in user units, so a head keeps to its line's weight instead of growing with it. */
export function ArrowDefs() {
  return (
    <defs>
      {ARROW_WIDTHS.flatMap((w) =>
        [false, true].map((lit) => {
          const size = 5 + 2.5 * w;
          return (
            <marker
              key={`${w}${lit}`}
              id={`graph-arrow-${w}${lit ? '-lit' : ''}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerUnits="userSpaceOnUse"
              markerWidth={size}
              markerHeight={size}
              orient="auto"
            >
              <path d="M0,0.5 L7.5,4 L0,7.5 z" fill={lit ? 'var(--accent)' : 'var(--fg-2)'} />
            </marker>
          );
        }),
      )}
    </defs>
  );
}
