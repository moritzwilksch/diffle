// The review as it opens on the feature branch: the file tree, every kind of changed file,
// and the layouts a reader switches between. Judge changes in the screenshots under
// `__snapshots__/review.spec.ts/`.
import { expect, test } from './fixtures.js';
import { collapsed, filePaths, gotoFile, header, walkToFile } from './harness.js';

test('opens on the first changed file with the tree and threads panel', async ({ page }) => {
  await expect(page.locator('header')).toContainText('17 files');
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

test('shows a binary change, a mode change and an empty file', async ({ page }) => {
  await gotoFile(page, 'assets/logo.png');
  await expect(page).toHaveScreenshot('binary-mode-empty.png');
});

test('renders CRLF endings, a missing trailing newline and a minified line', async ({ page }) => {
  await gotoFile(page, 'scripts/build.bat');
  await expect(page).toHaveScreenshot('line-endings.png');
  await gotoFile(page, 'web/vendor/sparkline.min.js');
  await expect(page).toHaveScreenshot('minified-line.png');
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
