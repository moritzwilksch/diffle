import { memo, useMemo } from 'react';
import { kindGlyph } from '@/client/connected/graph/glyphs.js';
import type { RoutedEdge } from '@/client/connected/graph/layout.js';
import {
  EDGE_STAGGER_CAP,
  arrowHead,
  curvePath,
  edgeLabel,
  edgeTitle,
  staggerVar,
  strokeWidth,
  trimEnd,
} from '@/client/connected/graph/view.js';

// Screen pixels (non-scaling stroke): a thin arrow stays easy to hit when zoomed out.
const HIT_WIDTH = 20;
const HEAD_BASE = 7;
const HEAD_PER_STROKE = 1.5;
const DASH = '6 5';
const PILL_HEIGHT = 20;
const PILL_PAD = 8;
const ICON = 12;

export interface GraphEdgeProps {
  edge: RoutedEdge;
  /** Entry order, for the stagger. */
  order: number;
  selected: boolean;
  lit: boolean;
  /** Vertical shift of the label, for the arrow that shares its middle with one the other way. */
  nudge?: number;
  onSelect(id: string): void;
  onHover(id: string | null): void;
}

const dim = (lit: boolean): string => (lit ? 'opacity-100' : 'opacity-35');

/** The curve and its arrowhead at the callee; thicker for more symbol pairs, dashed from an unchanged caller. */
export const GraphEdgeLine = memo(function GraphEdgeLine({
  edge,
  order,
  selected,
  lit,
  onSelect,
  onHover,
}: GraphEdgeProps) {
  const width = strokeWidth(edge.weight);
  const head = HEAD_BASE + width * HEAD_PER_STROKE;
  const { d, points } = useMemo(
    () => ({ d: curvePath(trimEnd(edge.points, head * 0.7)), points: arrowHead(edge.points, head) }),
    [edge.points, head],
  );
  // Butt caps: a round cap would leave a dot at the start while the arrow waits to draw on.
  const stroke = selected ? 'stroke-accent' : 'stroke-muted';
  return (
    <g
      data-motion="edge"
      className={`cursor-pointer ${dim(lit)}`}
      style={staggerVar('--i', order, EDGE_STAGGER_CAP)}
      aria-hidden
      data-graph-item
      onClick={(e) => {
        e.stopPropagation();
        onSelect(edge.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerEnter={() => onHover(edge.id)}
      onPointerLeave={() => onHover(null)}
    >
      <title>{edgeTitle(edge)}</title>
      {/* A wide invisible stroke: a 1.5px line is hard to hit. */}
      <path
        d={d}
        strokeWidth={HIT_WIDTH}
        vectorEffect="non-scaling-stroke"
        pointerEvents="stroke"
        className="fill-none stroke-transparent"
      />
      {/* A dashed arrow keeps its pixel dashes (a unit `pathLength` would swallow them) and fades in instead of drawing on. */}
      <path
        d={d}
        pathLength={edge.context ? undefined : 1}
        strokeWidth={selected ? width + 1 : width}
        strokeDasharray={edge.context ? DASH : undefined}
        data-motion={edge.context ? 'edge-fade' : 'edge-draw'}
        className={`fill-none ${stroke}`}
      />
      <polygon points={points} data-motion="edge-late" className={selected ? 'fill-accent' : 'fill-muted'} />
    </g>
  );
});

/** The pill on an arrow: the first symbol's kind icon and name, `+N` for the others; null when it names none. */
export const GraphEdgeLabel = memo(function GraphEdgeLabel({
  edge,
  order,
  selected,
  lit,
  nudge = 0,
  onSelect,
  onHover,
}: GraphEdgeProps) {
  const label = useMemo(() => edgeLabel(edge), [edge]);
  if (label.kind === null) return null;
  const glyph = kindGlyph(label.kind);
  const left = -label.width / 2;
  return (
    <g
      transform={`translate(${edge.label.x} ${edge.label.y + nudge})`}
      data-motion="edge"
      className="cursor-pointer"
      style={staggerVar('--i', order, EDGE_STAGGER_CAP)}
      aria-hidden
      data-graph-item
      onClick={(e) => {
        e.stopPropagation();
        onSelect(edge.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerEnter={() => onHover(edge.id)}
      onPointerLeave={() => onHover(null)}
    >
      <title>{edgeTitle(edge)}</title>
      <g data-motion="edge-late">
        {/* The fill stays opaque however dim the pill: dimming it would let the arrows show through. */}
        <rect
          x={left}
          y={-PILL_HEIGHT / 2}
          width={label.width}
          height={PILL_HEIGHT}
          rx={PILL_HEIGHT / 2}
          className="fill-card"
        />
        <g data-motion="dim" className={dim(lit)}>
          <rect
            x={left}
            y={-PILL_HEIGHT / 2}
            width={label.width}
            height={PILL_HEIGHT}
            rx={PILL_HEIGHT / 2}
            strokeWidth={selected ? 2 : 1}
            className={`fill-none ${selected ? 'stroke-accent' : 'stroke-border'}`}
          />
          <glyph.Icon x={left + PILL_PAD} y={-ICON / 2} width={ICON} height={ICON} className={glyph.text} />
          <text x={left + PILL_PAD + ICON + 4} y={3.5} className="fill-foreground font-mono text-[11px] select-none">
            {label.name}
            {label.more > 0 && (
              <tspan dx={4} className="fill-muted">
                +{label.more}
              </tspan>
            )}
          </text>
        </g>
      </g>
    </g>
  );
});
