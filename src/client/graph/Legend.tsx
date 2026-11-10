import { Pencil, Plus } from 'lucide-react';
import { FLOAT } from '@/client/canvas/CanvasToolbar.js';
import { KindIcon } from '@/client/lsp/symbolKind.js';

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

/** The graph's key: what the boxes, borders and arrows mean. */
export function Legend() {
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
