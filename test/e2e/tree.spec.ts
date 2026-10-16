import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from './fixtures.js';

/** Chromium's zoom step is 20%; a level of 1 is 120%, so 110% is log(1.1)/log(1.2) steps. */
const ZOOM_110 = Math.log(1.1) / Math.log(1.2);

// Browser zoom is a per-host profile preference, not a context option, so this page comes from a
// persistent profile that already holds 110% for the server's host. Only the full Chromium honors
// it; the headless shell every other scenario runs in ignores zoom levels.
const test = base.extend({
  context: async ({ browserName }, use, testInfo) => {
    test.skip(browserName !== 'chromium', 'zoom levels are a Chromium profile preference');
    const profile = await mkdtemp(join(tmpdir(), 'diffle-e2e-zoom-'));
    try {
      await mkdir(join(profile, 'Default'));
      await writeFile(
        join(profile, 'Default', 'Preferences'),
        JSON.stringify({ partition: { per_host_zoom_levels: { x: { '127.0.0.1': { zoom_level: ZOOM_110 } } } } }),
      );
      const { viewport, colorScheme, deviceScaleFactor, locale, timezoneId } = testInfo.project.use;
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        viewport,
        colorScheme,
        deviceScaleFactor,
        locale,
        timezoneId,
      });
      try {
        await use(context);
      } finally {
        await context.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
});

// The tree's ellipsis appears when a hidden wrapping copy of the name makes its cell taller than
// one line. At 110% zoom Chromium's fixed-point layout leaves every cell a fraction taller, which
// once painted an ellipsis over every name that fit (pierrecomputer/pierre#816).
test('regression: names that fit show no ellipsis at 110% browser zoom', async ({ page }) => {
  expect(await page.evaluate(() => devicePixelRatio)).toBeCloseTo(1.1, 5);
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
