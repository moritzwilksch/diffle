import { Focus, Folder, Rows3 } from 'lucide-react';
import { kindColor, KindIcon } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import { PART_HEADER } from '@/client/graph/layout/components.js';

// Text widths at the sizes below, to place the action just past the title and count.
const TITLE_CHAR = 7.9;
const COUNT_CHAR = 6.4;
const ROW = 28;
const BUTTON_H = 22;
/** The muted "around" before a hub's icon. */
const AROUND_W = 46;

/** What a header names its group by: the hub it is around, the folder its files share, or a plain title. */
export type HeaderName = { hub: GraphNode } | { folder: string } | { plain: string };

/** File view names a group by its files' shared folder; with none, or in symbol view, by its hub. */
export function groupName(hub: GraphNode, nodes: GraphNode[], files: boolean): HeaderName {
  if (!files) return { hub };
  const [first = [], ...rest] = nodes.map((n) => n.path.split('/').slice(0, -1));
  let shared = first.length;
  for (const dir of rest) {
    let i = 0;
    while (i < shared && dir[i] === first[i]) i++;
    shared = i;
  }
  return shared ? { folder: first.slice(0, shared).join('/') } : { hub };
}

/**
 * A group's heading row above its boxes, ruled across the whole graph: its name, how many boxes it
 * holds, and beside them the switch between it alone and every group, which shows on hover until it
 * is in use.
 */
export function PartHeader({
  name,
  count,
  noun,
  width,
  action,
}: {
  name: HeaderName;
  count: number;
  /** What the boxes are: symbols, or files in file view. */
  noun: 'symbol' | 'file';
  width: number;
  /** The part's key and whether it is shown alone; null for a header without the switch. */
  action: { partKey: string; showingOnly: boolean } | null;
}) {
  const top = -PART_HEADER;
  // A hub reads "around" it: the group is named after its most-used box, not made of it.
  const hub = 'hub' in name ? name.hub : null;
  const title = 'hub' in name ? name.hub.name : 'folder' in name ? `${name.folder}/` : name.plain;
  const plain = 'plain' in name;
  const hubColor = hub && kindColor(hub.kind);
  const iconX = hub ? AROUND_W : 0;
  const textX = plain ? 0 : iconX + 20;
  const countText = `${count} ${noun}${count === 1 ? '' : 's'}`;
  const textEnd = textX + title.length * (plain ? COUNT_CHAR + 0.6 : TITLE_CHAR) + 10 + countText.length * COUNT_CHAR;
  const label = action?.showingOnly ? 'Show all' : 'Show only';
  const buttonW = 28 + label.length * COUNT_CHAR;
  // Beside the text, where the eye already is; the rule still runs the whole row.
  const buttonX = textEnd + 12;
  const rowW = Math.max(width, buttonX + buttonW);
  return (
    <g className="group">
      <rect x={0} y={top} width={rowW} height={ROW} fill="transparent" />
      {hub && (
        <>
          <text x={0} y={top + 17} className="fill-muted font-sans text-[12px]">
            around
          </text>
          <KindIcon kind={hub.kind} x={iconX} y={top + 5} size={14} />
        </>
      )}
      {'folder' in name && <Folder x={0} y={top + 5} size={14} color="var(--fg-2)" />}
      <text x={textX} y={top + 17} className="font-sans text-[12px]">
        <tspan
          className={`fill-foreground ${plain ? '' : 'font-mono text-[13px]'}`}
          style={hubColor ? { fill: hubColor } : undefined}
          fontWeight={600}
        >
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
            x={buttonX}
            y={top + (ROW - BUTTON_H) / 2 - 1}
            width={buttonW}
            height={BUTTON_H}
            rx={5}
            fill="var(--bg-card)"
            stroke="var(--border)"
          />
          {action.showingOnly ? (
            <Rows3 x={buttonX + 8} y={top + 7} size={12} color="var(--fg-2)" />
          ) : (
            <Focus x={buttonX + 8} y={top + 7} size={12} color="var(--fg-2)" />
          )}
          <text x={buttonX + 24} y={top + 17} className="fill-foreground font-sans text-[11.5px]">
            {label}
          </text>
        </g>
      )}
    </g>
  );
}
