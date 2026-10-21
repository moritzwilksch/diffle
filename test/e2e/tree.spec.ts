import { expect, test as base } from './fixtures.js';

// Browser zoom is a per-host profile preference, which a browser served over the wire cannot take.
// Blink applies page zoom through the same effective zoom as the CSS `zoom` property, so the root
// is zoomed before the first layout instead; the layout rounding under test is the same.
const ZOOM_110 = 1.1;

const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript((zoom) => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.zoom = String(zoom);
      });
    }, ZOOM_110);
    await use(context);
  },
});

// The tree's ellipsis appears when a hidden wrapping copy of the name makes its cell taller than
// one line. At 110% zoom Chromium's fixed-point layout leaves every cell a fraction taller, which
// once painted an ellipsis over every name that fit (pierrecomputer/pierre#816).
test('regression: names that fit show no ellipsis at 110% browser zoom', async ({ page }) => {
  expect(await page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom))).toBeCloseTo(ZOOM_110, 5);
  const tree = page.locator('file-tree-container');
  await expect(tree.locator('[data-item-type="file"]').first()).toBeVisible();
  // Every fixture name fits the sidebar, so no marker may show.
  await expect
    .poll(() =>
      tree
        .locator('[data-truncate-marker]')
        .evaluateAll((markers) => markers.filter((marker) => getComputedStyle(marker).opacity !== '0').length),
    )
    .toBe(0);
  await expect(page.locator('aside.tree-theme')).toHaveScreenshot('zoomed-tree.png');
});
