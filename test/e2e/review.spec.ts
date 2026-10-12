// The review as it opens on the feature branch: the file tree, every kind of changed file,
// and the layouts a reader switches between. Judge changes in the screenshots under
// `__snapshots__/review.spec.ts/`.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { clickLine, collapsed, filePaths, gotoFile, header, waitForHighlight, walkToFile } from './browser.js';

test('opens on the first changed file with the tree and threads panel', async ({ page }) => {
  await expect(page.locator('header')).toContainText('17 files');
  await waitForHighlight(page, 'tally/cli.py');
  await expect(page).toHaveScreenshot('overview.png');
});

test('lists the changed files in tree order with their statuses', async ({ page }) => {
  expect(await filePaths(page)).toEqual([
    'assets/logo.png',
    'docs/guide/Übersicht.md',
    'scripts/build.bat',
    'scripts/tally.sh',
    'tally/generated/openapi.py',
    'tally/cli.py',
    'tally/currency.py',
    'tally/ledger.py',
    'tally/legacy.py',
    'tally/py.typed',
    'tally/refunds.py',
    'tally/schema.json',
    'tests/test_ledger.py',
    'tests/test_refunds.py',
    'web/vendor/sparkline.min.js',
    'requirements.lock',
    'VERSION',
  ]);
});

test('starts generated files collapsed and the rest expanded', async ({ page }) => {
  for (const path of [
    'tally/generated/openapi.py',
    'tally/schema.json',
    'requirements.lock',
    'web/vendor/sparkline.min.js',
  ]) {
    await walkToFile(page, path);
    expect(await collapsed(page, path), `${path} should start collapsed`).toBe(true);
    await expect(await header(page, path)).toContainText('generated');
  }
  await walkToFile(page, 'tally/ledger.py');
  expect(await collapsed(page, 'tally/ledger.py')).toBe(false);
  await walkToFile(page, 'tally/schema.json');
  await expect(page).toHaveScreenshot('generated-files.png');
});

test('shows a rename with edits and the pure rename next to it', async ({ page }) => {
  await gotoFile(page, 'tally/currency.py');
  await expect(await header(page, 'tally/currency.py')).toContainText('money.py');
  await expect(page).toHaveScreenshot('rename.png');
});

// One screenshot per scenario: a failing first screenshot would otherwise hide the second one's result.
test('renders CRLF endings', async ({ page }) => {
  await gotoFile(page, 'scripts/build.bat');
  await expect(page).toHaveScreenshot('line-endings.png');
});

test('renders a minified line and a missing trailing newline', async ({ page }) => {
  await gotoFile(page, 'web/vendor/sparkline.min.js');
  await expect(page).toHaveScreenshot('minified-line.png');
});

/** How far the furthest-scrolled code column sits from its start, in pixels. */
const scrolledSideways = (page: Page) =>
  page.locator('[data-code]').evaluateAll((codes) => Math.max(0, ...codes.map((c) => c.scrollLeft)));

test('scrolls a minified line to its last word with wrapping off', async ({ page }) => {
  await gotoFile(page, 'web/vendor/sparkline.min.js');
  await page.keyboard.press('z');
  await page.keyboard.press('w');
  await expect(page.locator('pre[data-overflow="scroll"]').first()).toBeAttached();
  await clickLine(page, 'web/vendor/sparkline.min.js', 1);
  expect(await scrolledSideways(page)).toBe(0);
  await page.keyboard.press('$');
  await expect.poll(() => scrolledSideways(page)).toBeGreaterThan(0);
  await expect(page).toHaveScreenshot('no-wrap-last-word.png');
  const end = await scrolledSideways(page);
  await page.keyboard.press('z');
  await page.keyboard.press('h');
  await expect.poll(() => scrolledSideways(page)).toBeLessThan(end);
  await page.keyboard.press('z');
  await page.keyboard.press('l');
  await expect.poll(() => scrolledSideways(page)).toBe(end);
});

test('scrolls a search match into view with wrapping off', async ({ page }) => {
  await gotoFile(page, 'web/vendor/sparkline.min.js');
  await page.keyboard.press('z');
  await page.keyboard.press('w');
  await expect(page.locator('pre[data-overflow="scroll"]').first()).toBeAttached();
  await page.keyboard.press('/');
  const search = page.locator('[data-content-search]');
  await search.fill('strokeWidth');
  await search.press('Enter');
  await expect(page.getByText(/^1 \/ 1$/)).toBeVisible();
  await expect.poll(() => scrolledSideways(page)).toBeGreaterThan(0);
  await expect(page).toHaveScreenshot('no-wrap-search.png');
});

test('switches to the unified layout', async ({ page }) => {
  await gotoFile(page, 'tally/ledger.py');
  await page.keyboard.press('s');
  await expect(page.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveScreenshot('unified.png');
});

test('hides the tree and the panel for a wide diff', async ({ page }) => {
  await gotoFile(page, 'tally/ledger.py');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+Shift+b');
  await expect(page.locator('file-tree-container')).toHaveCount(0);
  await expect(page).toHaveScreenshot('diff-only.png');
});
