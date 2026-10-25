import { Info, Maximize, Minus, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { KindIcon } from '@/client/lsp/symbolKind.js';
import { Button, TOGGLE_ON } from '@/client/ui/Button.js';

const KINDS: [number, string][] = [
  [12, 'function'],
  [6, 'method'],
  [5, 'class'],
  [23, 'struct'],
  [11, 'interface'],
  [10, 'enum'],
  [26, 'type'],
  [1, 'file / top level'],
];

const FLOAT = 'absolute right-3 z-10 rounded-lg border border-border bg-surface shadow-card';

/**
 * The canvas's one floating toolbar, bottom right: the legend's switch, then zoom out, the zoom
 * level (a click returns to 100%), zoom in and fit; the keys do the same with + - 0. The legend
 * opens above it.
 */
export function CanvasToolbar({
  zoom,
  onZoom,
  onFit,
}: {
  zoom: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
}) {
  const [legend, setLegend] = useState(false);
  return (
    <>
      {legend && <Legend />}
      <div className={`${FLOAT} bottom-3 flex items-center gap-0.5 p-0.5`}>
        <Button
          variant="ghost"
          icon
          onClick={() => setLegend(!legend)}
          aria-pressed={legend}
          title="Legend"
          aria-label="Legend"
          className={legend ? TOGGLE_ON : undefined}
        >
          <Info size="0.875rem" />
        </Button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Button variant="ghost" icon onClick={() => onZoom(0.8)} title="Zoom out (-)" aria-label="Zoom out">
          <Minus size="0.875rem" />
        </Button>
        <Button
          variant="ghost"
          className="w-12 justify-center px-0 font-mono text-[0.75rem] tabular-nums"
          onClick={() => onZoom(1 / zoom)}
          aria-label="Zoom to 100%"
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button variant="ghost" icon onClick={() => onZoom(1.25)} title="Zoom in (+)" aria-label="Zoom in">
          <Plus size="0.875rem" />
        </Button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Button variant="ghost" icon onClick={onFit} title="Fit (0)" aria-label="Fit">
          <Maximize size="0.875rem" />
        </Button>
      </div>
    </>
  );
}

/** The graph's key: what the boxes, borders and arrows mean. */
function Legend() {
  return (
    <div className={`${FLOAT} bottom-14 flex w-60 flex-col gap-2 p-3 text-[0.75rem]`}>
      <div className="font-semibold">Legend</div>
      <Row swatch={<Box border="var(--add)" icon={<Plus size={10} color="var(--add)" />} />}>
        <span className="text-add">added</span>
      </Row>
      <Row swatch={<Box border="var(--accent)" icon={<Pencil size={10} color="var(--accent)" />} />}>
        <span className="text-accent">modified</span>
      </Row>
      <Row swatch={<Box border="var(--border)" dashed />}>unchanged, uses the change</Row>
      <Row swatch={<span className="w-6 border-t-2 border-dashed border-muted" />}>arrow inside a cycle</Row>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 pt-1">
        {KINDS.map(([kind, label]) => (
          <span key={kind} className="inline-flex items-center gap-1.5 text-muted">
            <KindIcon kind={kind} size="0.75rem" /> {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex w-10 shrink-0 justify-center">{swatch}</span>
      <span className="text-muted">{children}</span>
    </div>
  );
}

function Box({ border, icon, dashed }: { border: string; icon?: React.ReactNode; dashed?: boolean }) {
  return (
    <span
      className="flex h-4 w-6 items-center justify-center rounded-sm border bg-canvas"
      style={{ borderColor: border, borderStyle: dashed ? 'dashed' : 'solid' }}
    >
      {icon}
    </span>
  );
}
