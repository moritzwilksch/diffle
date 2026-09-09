import { describe, expect, it } from 'vitest';
import { reviewGeometry } from '../../src/client/review/geometry.js';

describe('review geometry', () => {
  it.each([
    { rem: 14.4, lineHeight: 18, spacing: 7, diffHeaderHeight: 39, hunkSeparatorHeight: 29 },
    { rem: 16, lineHeight: 20, spacing: 8, diffHeaderHeight: 44, hunkSeparatorHeight: 32 },
    { rem: 18, lineHeight: 23, spacing: 9, diffHeaderHeight: 50, hunkSeparatorHeight: 36 },
  ])('shares row, header and separator sizes with CSS at $rem px/rem', ({ rem, ...metrics }) => {
    const { itemMetrics, css } = reviewGeometry(rem);
    expect(itemMetrics).toEqual(metrics);
    expect(css).toContain(`--diffs-line-height: ${metrics.lineHeight}px;`);
    expect(css).toContain(`--diffs-gap-block: ${metrics.spacing}px;`);
    expect(css).toContain(`--diffs-gap-inline: ${metrics.spacing}px;`);
    expect(css).toContain(`height: ${metrics.diffHeaderHeight}px;`);
    expect(css).toContain(`min-height: ${metrics.diffHeaderHeight}px;`);
    expect(css).toContain(`[data-separator='line-info'] { height: ${metrics.hunkSeparatorHeight}px; }`);
    expect(css).toContain('box-sizing: border-box;');
  });

  it('quantizes primitive sizes before composing them, so fractional roots cannot accumulate row drift', () => {
    const { itemMetrics, layout, edge } = reviewGeometry(13.37);
    for (const value of [...Object.values(itemMetrics), ...Object.values(layout), edge]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(itemMetrics.diffHeaderHeight).toBe(itemMetrics.lineHeight + 3 * itemMetrics.spacing);
  });

  it('scales card spacing and navigation margins with the same root', () => {
    expect(reviewGeometry(16).layout).toEqual({ paddingTop: 12, paddingBottom: 200, gap: 16 });
    expect(reviewGeometry(16).edge).toBe(48);
    expect(reviewGeometry(14.4).layout).toEqual({ paddingTop: 11, paddingBottom: 180, gap: 14 });
    expect(reviewGeometry(14.4).edge).toBe(43);
  });
});
