import { memo, type CSSProperties, type FocusEvent } from 'react';
import { STATUS } from '@/client/connected/graph/glyphs.js';
import type { NodeStatus } from '@/client/connected/graph/model.js';
import { TEST_TAG_WIDTH, type PlacedNode } from '@/client/connected/graph/layout.js';
import { NODE_STAGGER_CAP, fitText, nodeLabel, staggerVar } from '@/client/connected/graph/view.js';

const NAME_X = 38;
const PAD_RIGHT = 10;
const BADGE = 24;
const ICON = 14;
const RADIUS = 8;
// Approximate advances (13px semibold sans, 10.5px sans, 10.5px mono): text is cut to its room, not measured.
const NAME_CHAR = 7.2;
const DIR_CHAR = 5.6;
const META_CHAR = 6.3;
const SELECT_GAP = 4;
const FOCUS_GAP = 8;
// The counts sit clear of the focus ring (FOCUS_GAP + half its stroke), and layout.ts's NODE_SEP leaves them room.
const COUNTS_Y = 20;
const TAG_HEIGHT = 14;
// The tag's width: what the layout reserves for it, less a gap to the name.
const TAG_WIDTH = TEST_TAG_WIDTH - 5;

/** Literal class names, so Tailwind sees them: border, badge tint per status. */
const TONE: Record<NodeStatus, { border: string; badge: string }> = {
  added: { border: 'stroke-add', badge: 'fill-add/15' },
  modified: { border: 'stroke-accent', badge: 'fill-accent/15' },
  deleted: { border: 'stroke-del', badge: 'fill-del/15' },
  renamed: { border: 'stroke-kind-type', badge: 'fill-kind-type/15' },
  context: { border: 'stroke-muted', badge: 'fill-muted/15' },
};

export interface GraphNodeProps {
  node: PlacedNode;
  /** Entry order, for the stagger. */
  order: number;
  /** The one node in the tab order. */
  tabbable: boolean;
  selected: boolean;
  lit: boolean;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onHover(id: string | null): void;
  onFocusNode(id: string, keyboard: boolean): void;
  onBlurNode(id: string): void;
}

/** One file: a card with a status border and badge, its name, directory and +/- counts. Focusable, roving. */
export const GraphNode = memo(function GraphNode(props: GraphNodeProps) {
  const { node, order, tabbable, selected, lit } = props;
  const { w, h } = node;
  const status = STATUS[node.status];
  const tone = TONE[node.status];
  const context = node.status === 'context';
  const metaChars = context ? 'unchanged'.length : `+${node.add} -${node.del}`.length;
  const tagRoom = node.test ? TEST_TAG_WIDTH : 0;
  const dir = fitText(node.dir, w - NAME_X - PAD_RIGHT - metaChars * META_CHAR - 6, DIR_CHAR);
  const style: CSSProperties = {
    transform: `translate(${node.x - w / 2}px, ${node.y - h / 2}px)`,
    ...staggerVar('--i', order, NODE_STAGGER_CAP),
  };
  return (
    <g
      data-motion="node"
      className={`group cursor-pointer outline-none ${lit ? 'opacity-100' : 'opacity-50'}`}
      style={style}
      role="button"
      tabIndex={tabbable ? 0 : -1}
      aria-label={nodeLabel(node)}
      aria-pressed={selected}
      data-graph-item
      data-node-id={node.id}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelect(node.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        props.onOpen(node.id);
      }}
      onPointerEnter={() => props.onHover(node.id)}
      onPointerLeave={() => props.onHover(null)}
      onFocus={(e: FocusEvent<SVGGElement>) => props.onFocusNode(node.id, e.currentTarget.matches(':focus-visible'))}
      onBlur={() => props.onBlurNode(node.id)}
    >
      <title>{node.id}</title>
      <g data-motion="node-in">
        {/* Keyboard focus only; a second, outer ring so it reads over the selection ring. */}
        <rect
          x={-FOCUS_GAP}
          y={-FOCUS_GAP}
          width={w + 2 * FOCUS_GAP}
          height={h + 2 * FOCUS_GAP}
          rx={RADIUS + FOCUS_GAP}
          strokeWidth={2}
          className="fill-none stroke-transparent group-focus-visible:stroke-foreground"
        />
        {selected && (
          <rect
            x={-SELECT_GAP}
            y={-SELECT_GAP}
            width={w + 2 * SELECT_GAP}
            height={h + 2 * SELECT_GAP}
            rx={RADIUS + SELECT_GAP}
            strokeWidth={2.5}
            className="fill-none stroke-accent"
          />
        )}
        {/* A test card is the canvas colour with a thin border: it recedes, and keeps its status colour. */}
        <rect
          width={w}
          height={h}
          rx={RADIUS}
          strokeWidth={node.test ? 1 : 1.5}
          strokeDasharray={context ? '5 4' : undefined}
          className={`${node.test ? 'fill-surface' : 'fill-card'} ${tone.border}`}
        />
        <rect x={8} y={(h - BADGE) / 2} width={BADGE} height={BADGE} rx={6} className={tone.badge} />
        <status.Icon
          x={8 + (BADGE - ICON) / 2}
          y={(h - BADGE) / 2 + (BADGE - ICON) / 2}
          width={ICON}
          height={ICON}
          aria-hidden
          className={status.text}
        />
        <text
          x={NAME_X}
          y={h / 2 - 3}
          className={`${node.test ? 'fill-muted' : 'fill-foreground'} font-sans text-[13px] font-semibold select-none`}
        >
          {fitText(node.name, w - NAME_X - PAD_RIGHT - tagRoom, NAME_CHAR)}
        </text>
        {node.test && (
          <g aria-hidden>
            <rect
              x={w - PAD_RIGHT - TAG_WIDTH}
              y={h / 2 - TAG_HEIGHT}
              width={TAG_WIDTH}
              height={TAG_HEIGHT}
              rx={3}
              className="fill-muted/15"
            />
            <text
              x={w - PAD_RIGHT - TAG_WIDTH / 2}
              y={h / 2 - 3}
              textAnchor="middle"
              className="fill-muted font-sans text-[10px] font-semibold select-none"
            >
              test
            </text>
          </g>
        )}
        {dir && (
          <text x={NAME_X} y={h / 2 + 12} className="fill-muted font-sans text-[10.5px] select-none">
            {dir}
          </text>
        )}
        <text
          x={w - PAD_RIGHT}
          y={h / 2 + 12}
          textAnchor="end"
          className="font-mono text-[10.5px] select-none"
          aria-hidden
        >
          {context ? (
            <tspan className="fill-muted">unchanged</tspan>
          ) : (
            <>
              <tspan className="fill-add">+{node.add}</tspan>
              <tspan className="fill-del" dx={4}>
                -{node.del}
              </tspan>
            </>
          )}
        </text>
        <text x={4} y={h + COUNTS_Y} className="fill-muted font-mono text-[10px] select-none" aria-hidden>
          {`←${node.in} →${node.out}`}
        </text>
      </g>
    </g>
  );
});
