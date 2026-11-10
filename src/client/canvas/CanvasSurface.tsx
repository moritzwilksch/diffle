import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from 'react';
import { ArrowDefs, CANVAS_BG } from './arrows.js';
import { EASE_MS, type View, type Viewport } from './viewport.js';

/** The dot grid's spacing at zoom 1. */
const GRID = 20;

/** Content panned and zoomed with the view. */
function layer(view: View): CSSProperties {
  return {
    transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`,
    transformOrigin: '0 0',
    transition: view.ease ? `transform ${EASE_MS}ms ease-out` : undefined,
  };
}

/**
 * A faint grey with a dot grid that pans and zooms with the content: the cue that it drags. `svg`
 * draws in an SVG layer named `label`; `html`, when given, sits above it in a layer moved the same way.
 */
export function CanvasSurface({
  viewport,
  label,
  svg,
  html,
  onClick,
  onDoubleClick,
  onPointerOver,
  onPointerLeave,
}: {
  viewport: Viewport;
  label: string;
  svg: ReactNode;
  html?: ReactNode;
  onClick?: (e: MouseEvent) => void;
  onDoubleClick?: () => void;
  onPointerOver?: (e: PointerEvent) => void;
  onPointerLeave?: () => void;
}) {
  const { view, host, pointer } = viewport;
  return (
    <div
      ref={host}
      className="relative h-full w-full cursor-grab touch-none overflow-hidden overscroll-none select-none active:cursor-grabbing"
      style={{
        backgroundColor: CANVAS_BG,
        backgroundImage: 'radial-gradient(color-mix(in srgb, var(--fg) 18%, transparent) 1px, transparent 1.2px)',
        backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
        transition: view.ease
          ? `background-size ${EASE_MS}ms ease-out, background-position ${EASE_MS}ms ease-out`
          : undefined,
      }}
      {...pointer}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onPointerOver={onPointerOver}
      onPointerLeave={onPointerLeave}
    >
      <svg className="absolute inset-0 h-full w-full" role="img" aria-label={label}>
        <ArrowDefs />
        <g style={layer(view)} className="motion-reduce:transition-none!">
          {svg}
        </g>
      </svg>
      {html && (
        <div style={layer(view)} className="absolute top-0 left-0 motion-reduce:transition-none!">
          {html}
        </div>
      )}
    </div>
  );
}
