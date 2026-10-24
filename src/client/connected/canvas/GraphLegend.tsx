import { Info, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/client/ui/Button.js';
import { STATUS, kindGlyph } from '@/client/connected/graph/glyphs.js';
import type { NodeStatus } from '@/client/connected/graph/model.js';

const STATUS_ORDER: readonly NodeStatus[] = ['added', 'modified', 'deleted', 'renamed', 'context'];
/** One representative SymbolKind per colour group of an arrow's label. */
const KIND_GROUPS = [
  { name: 'Types', kind: 5 },
  { name: 'Functions', kind: 12 },
  { name: 'Values', kind: 13 },
] as const;

function Heading({ children }: { children: string }) {
  return <div className="mt-2 mb-0.5 text-[12px] font-semibold text-muted first:mt-0">{children}</div>;
}

function Line({ dashed, children }: { dashed?: boolean; children: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width={22} height={8} aria-hidden className="flex-none">
        <line
          x1={1}
          y1={4}
          x2={21}
          y2={4}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={dashed ? '4 3' : undefined}
          className="stroke-muted"
        />
      </svg>
      {children}
    </div>
  );
}

/** A test file's card in miniature: the canvas colour with a thin border, lower than a source card. */
function TestSwatch() {
  return (
    <div className="flex items-center gap-1.5">
      <svg width={22} height={10} aria-hidden className="flex-none">
        <rect x={1} y={1.5} width={20} height={7} rx={2} strokeWidth={1} className="fill-surface stroke-muted" />
      </svg>
      Test file
    </div>
  );
}

/** A collapsed-by-default key to the graph's colours, icons and line styles; sits over the bottom-left corner. */
export function GraphLegend() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="absolute bottom-3 left-3 z-10 text-[12px]">
      {open ? (
        <section
          id={id}
          aria-label="Legend"
          data-motion="legend-in"
          className="w-56 rounded-lg border border-border bg-card p-2.5 shadow-card"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="font-semibold">Legend</span>
            <Button
              variant="ghost"
              icon
              type="button"
              aria-label="Hide legend"
              title="Hide legend"
              aria-expanded
              aria-controls={id}
              onClick={() => setOpen(false)}
            >
              <X size={12} />
            </Button>
          </div>
          <Heading>File</Heading>
          {STATUS_ORDER.map((s) => {
            const g = STATUS[s];
            return (
              <div key={s} className="flex items-center gap-1.5">
                <g.Icon size={12} aria-hidden className={g.text} />
                {g.label}
              </div>
            );
          })}
          <Line>Changed file</Line>
          <Line dashed>Unchanged caller</Line>
          <TestSwatch />
          <Heading>Arrow labels</Heading>
          {KIND_GROUPS.map((k) => {
            const g = kindGlyph(k.kind);
            return (
              <div key={k.name} className="flex items-center gap-1.5">
                <g.Icon size={12} aria-hidden className={g.text} />
                {k.name}
              </div>
            );
          })}
          <Heading>Reading</Heading>
          <div>Arrow = uses: caller → callee</div>
          <div className="font-mono text-[11px] text-muted">←n used by · →n uses</div>
        </section>
      ) : (
        <Button
          type="button"
          aria-expanded={false}
          title="Show legend"
          className="shadow-card"
          onClick={() => setOpen(true)}
        >
          <Info size={12} aria-hidden />
          Legend
        </Button>
      )}
    </div>
  );
}

export interface GraphControlsProps {
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
}

/** Zoom in, zoom out and fit, stacked over the bottom-right corner. */
export function GraphControls({ onZoomIn, onZoomOut, onFit }: GraphControlsProps) {
  return (
    <div className="absolute right-3 bottom-3 z-10 flex flex-col gap-1">
      <Button type="button" icon aria-label="Zoom in" title="Zoom in (+)" onClick={onZoomIn}>
        <ZoomIn size={14} />
      </Button>
      <Button type="button" icon aria-label="Zoom out" title="Zoom out (-)" onClick={onZoomOut}>
        <ZoomOut size={14} />
      </Button>
      <Button type="button" icon aria-label="Fit to view" title="Fit to view (0)" onClick={onFit}>
        <Maximize size={14} />
      </Button>
    </div>
  );
}
