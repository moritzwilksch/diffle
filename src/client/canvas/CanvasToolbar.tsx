import { Info, Maximize, Minus, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button, TOGGLE_ON } from '@/client/ui/Button.js';

/** A panel floating over the canvas's right edge. */
export const FLOAT = 'absolute right-3 z-10 rounded-lg border border-border bg-surface shadow-card';

/**
 * The canvas's one floating toolbar, bottom right: the legend's switch when there is a legend, then
 * zoom out, the zoom level (a click returns to 100%), zoom in and fit; the keys do the same with
 * + - 0. The legend opens above it.
 */
export function CanvasToolbar({
  zoom,
  onZoom,
  onFit,
  legend,
}: {
  zoom: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  legend?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {legend && open && legend}
      <div className={`${FLOAT} bottom-3 flex items-center gap-0.5 p-0.5`}>
        {legend && (
          <>
            <Button
              variant="ghost"
              icon
              onClick={() => setOpen(!open)}
              aria-pressed={open}
              title="Legend"
              aria-label="Legend"
              className={open ? TOGGLE_ON : undefined}
            >
              <Info size="0.875rem" />
            </Button>
            <span className="mx-0.5 h-4 w-px bg-border" />
          </>
        )}
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
