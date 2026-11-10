// What every canvas draws with: its grey, and arrowheads that keep to their line's weight.

/** The canvas grey, also under a box that must hide the dot grid. */
export const CANVAS_BG = 'color-mix(in srgb, var(--fg) 2.5%, var(--bg))';

/** Stroke widths an arrow is drawn in; each has its own head, sized to it. */
export const ARROW_WIDTHS = [1, 2, 3] as const;

/** The arrowhead for a stroke of `width`, muted or lit. */
export const arrowHead = (width: number, lit: boolean) => `url(#canvas-arrow-${width}${lit ? '-lit' : ''})`;

/** Arrowheads in user units, so a head keeps to its line's weight instead of growing with it. */
export function ArrowDefs() {
  return (
    <defs>
      {ARROW_WIDTHS.flatMap((w) =>
        [false, true].map((lit) => {
          const size = 5 + 2.5 * w;
          return (
            <marker
              key={`${w}${lit}`}
              id={`canvas-arrow-${w}${lit ? '-lit' : ''}`}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerUnits="userSpaceOnUse"
              markerWidth={size}
              markerHeight={size}
              orient="auto"
            >
              <path d="M0,0.5 L7.5,4 L0,7.5 z" fill={lit ? 'var(--accent)' : 'var(--fg-2)'} />
            </marker>
          );
        }),
      )}
    </defs>
  );
}
