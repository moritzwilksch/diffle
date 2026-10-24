import { Focus, Rows3 } from 'lucide-react';
import { kindGroup, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { PART_HEADER } from '@/client/graph/layout/components.js';

const KIND_COLOR: Record<string, string> = {
  type: 'var(--kind-type)',
  callable: 'var(--kind-callable)',
  value: 'var(--kind-value)',
};

// Text widths at the sizes below, to place the action past the title.
const TITLE_CHAR = 7.9;
const COUNT_CHAR = 6.4;
const ROW = 28;
const BUTTON_H = 22;

/**
 * A group's heading row above its boxes, ruled across the whole graph: the hub symbol it is named
 * after (or a plain title), how many boxes it holds, and the switch between it alone and every
 * group, which shows on hover until it is in use.
 */
export function PartHeader({
  hub,
  title,
  count,
  noun,
  width,
  action,
}: {
  hub: GraphNode | null;
  title: string;
  count: number;
  /** What the boxes are: symbols, or files in file view. */
  noun: 'symbol' | 'file';
  width: number;
  /** The part's key and whether it is shown alone; null for a header without the switch. */
  action: { partKey: string; showingOnly: boolean } | null;
}) {
  const top = -PART_HEADER;
  const textX = hub ? 20 : 0;
  const countText = `${count} ${noun}${count === 1 ? '' : 's'}`;
  const textEnd = textX + title.length * (hub ? TITLE_CHAR : COUNT_CHAR + 0.6) + 10 + countText.length * COUNT_CHAR;
  const label = action?.showingOnly ? 'Show all' : 'Show only';
  const buttonW = 28 + label.length * COUNT_CHAR;
  const rowW = Math.max(width, textEnd + 16 + buttonW);
  return (
    <g className="group">
      <rect x={0} y={top} width={rowW} height={ROW} fill="transparent" />
      {hub && (
        <KindIcon
          kind={hub.kind}
          x={0}
          y={top + 5}
          size={14}
          color={KIND_COLOR[kindGroup(hub.kind)] ?? 'var(--fg-2)'}
        />
      )}
      <text x={textX} y={top + 17} className="font-sans text-[12px]">
        <tspan className={`fill-foreground ${hub ? 'font-mono text-[13px]' : ''}`} fontWeight={600}>
          {title}
        </tspan>
        <tspan className="fill-muted" dx={10}>
          {countText}
        </tspan>
      </text>
      <line x1={0} x2={rowW} y1={top + ROW} y2={top + ROW} stroke="var(--border)" strokeOpacity={0.6} />
      {action && (
        <g
          data-part={action.partKey}
          className={`cursor-pointer transition-opacity ${action.showingOnly ? '' : 'opacity-0 group-hover:opacity-100'}`}
        >
          <rect
            x={rowW - buttonW}
            y={top + (ROW - BUTTON_H) / 2 - 1}
            width={buttonW}
            height={BUTTON_H}
            rx={5}
            fill="var(--bg-card)"
            stroke="var(--border)"
          />
          {action.showingOnly ? (
            <Rows3 x={rowW - buttonW + 8} y={top + 7} size={12} color="var(--fg-2)" />
          ) : (
            <Focus x={rowW - buttonW + 8} y={top + 7} size={12} color="var(--fg-2)" />
          )}
          <text x={rowW - buttonW + 24} y={top + 17} className="fill-foreground font-sans text-[11.5px]">
            {label}
          </text>
        </g>
      )}
    </g>
  );
}
