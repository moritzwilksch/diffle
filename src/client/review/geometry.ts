import type { CodeViewOptions } from '@pierre/diffs';

/** Shared CSS and virtual geometry in CSS pixels at the current root font size. */
export function reviewGeometry(rem: number) {
  // Whole CSS pixels avoid accumulating browser-specific fractional row rounding.
  const px = (value: number) => Math.round(value * rem);
  const lineHeight = px(1.25);
  const spacing = px(0.5);
  const diffHeaderHeight = lineHeight + 3 * spacing;
  const hunkSeparatorHeight = px(2);
  const itemMetrics = { lineHeight, spacing, diffHeaderHeight, hunkSeparatorHeight };
  const layout = { paddingTop: px(0.75), paddingBottom: px(12.5), gap: px(1) };
  const css = `
:host {
  --diffs-font-size: ${px(0.8125)}px;
  --diffs-line-height: ${lineHeight}px;
  --diffs-gap-block: ${spacing}px;
  --diffs-gap-inline: ${spacing}px;
}
/* Header metadata and borders must not enlarge the virtual header region. */
[data-diffs-header] {
  box-sizing: border-box;
  height: ${diffHeaderHeight}px;
  min-height: ${diffHeaderHeight}px;
}
[data-separator='line-info'] { height: ${hunkSeparatorHeight}px; }
`;
  return { itemMetrics, layout, css, edge: px(3) } satisfies {
    itemMetrics: CodeViewOptions<unknown>['itemMetrics'];
    layout: CodeViewOptions<unknown>['layout'];
    css: string;
    edge: number;
  };
}
