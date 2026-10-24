import { Info, Maximize, Pencil, Plus, ZoomIn, ZoomOut } from 'lucide-react';
import { useState } from 'react';
import { KindIcon } from '@/client/lsp/symbolKind.js';
import { Button } from '@/client/ui/Button.js';

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

const CORNER = 'absolute z-10 rounded-lg border border-border bg-surface shadow-card';

/** The graph's key, folded into a button in the bottom-left corner until asked for. */
export function GraphLegend() {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button className={`${CORNER} bottom-3 left-3`} onClick={() => setOpen(true)} title="What the shapes mean">
        <Info size="0.875rem" /> Legend
      </Button>
    );
  return (
    <div className={`${CORNER} bottom-3 left-3 flex w-60 flex-col gap-2 p-3 text-[0.75rem]`}>
      <div className="flex items-center justify-between font-semibold">
        Legend
        <Button variant="ghost" className="px-1.5 py-0" onClick={() => setOpen(false)}>
          Hide
        </Button>
      </div>
      <Row swatch={<Box border="var(--add)" icon={<Plus size={10} color="var(--add)" />} />}>
        <span className="text-add">added</span>
      </Row>
      <Row swatch={<Box border="var(--accent)" icon={<Pencil size={10} color="var(--accent)" />} />}>
        <span className="text-accent">modified</span>
      </Row>
      <Row swatch={<Box border="var(--border)" dashed />}>unchanged, uses the change</Row>
      <Row swatch={<span className="font-mono text-[0.625rem] whitespace-nowrap text-muted">→2 1→</span>}>
        used by 2, uses 1
      </Row>
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

/** Zoom and fit, in the bottom-right corner; the keys do the same with + - 0. */
export function ZoomControls({ zoom, fit }: { zoom: (factor: number) => void; fit: () => void }) {
  return (
    <div className={`${CORNER} right-3 bottom-3 flex flex-col p-0.5`}>
      <Button variant="ghost" icon onClick={() => zoom(1.25)} title="Zoom in (+)" aria-label="Zoom in">
        <ZoomIn size="0.875rem" />
      </Button>
      <Button variant="ghost" icon onClick={() => zoom(0.8)} title="Zoom out (-)" aria-label="Zoom out">
        <ZoomOut size="0.875rem" />
      </Button>
      <Button variant="ghost" icon onClick={fit} title="Fit (0)" aria-label="Fit">
        <Maximize size="0.875rem" />
      </Button>
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
