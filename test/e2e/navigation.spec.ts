import { expect, test } from './fixtures.js';
import { activePath, gotoFile, viewed, collapsed } from './browser.js';

test('marks a file viewed, collapses it and moves on', async ({ page }) => {
  await gotoFile(page, 'scripts/build.bat');
  await page.keyboard.press('v');
  expect(await viewed(page, 'scripts/build.bat')).toBe(true);
  expect(await collapsed(page, 'scripts/build.bat')).toBe(true);
  await expect(page.locator('file-tree-container')).toContainText('✓');
  await expect(page).toHaveScreenshot('viewed.png');
});

test('regression: selecting an empty file keeps that file active', async ({ page }) => {
  await gotoFile(page, 'tally/py.typed');
  await expect(page.locator('file-tree-container [data-item-path="tally/py.typed"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const title = page.locator('[slot="header-custom"] [data-path="tally/py.typed"]');
  await title.getByText('py.typed', { exact: true }).click();
  await expect(page.locator('file-tree-container [data-item-path="tally/py.typed"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await viewed(page, 'tally/py.typed')).toBe(false);
});

test('regression: clicking the active collapsed file in the tree expands it again', async ({ page }) => {
  await gotoFile(page, 'tally/ledger.py');
  const title = page.locator('[slot="header-custom"] [data-path="tally/ledger.py"]');
  await title.getByRole('button', { name: 'Collapse / expand' }).click();
  await expect.poll(() => collapsed(page, 'tally/ledger.py')).toBe(true);
  await gotoFile(page, 'tally/ledger.py');
  await expect.poll(() => collapsed(page, 'tally/ledger.py')).toBe(false);
  expect(await viewed(page, 'tally/ledger.py')).toBe(false);
});

test('gv marks the file above viewed and keeps the cursor in place', async ({ page }) => {
  await gotoFile(page, 'tally/cli.py');
  // Skim with `]` until the cursor crosses into the next file, as a reader finishing cli.py would.
  while ((await activePath(page)) !== 'tally/currency.py') await page.keyboard.press(']');
  const cursor = page.locator('[data-line][data-selected-line]').first();
  await expect(cursor).toBeVisible();
  const before = (await cursor.boundingBox())!.y;
  await page.keyboard.press('g');
  await page.keyboard.press('v');
  await expect.poll(() => viewed(page, 'tally/cli.py')).toBe(true);
  expect(await collapsed(page, 'tally/cli.py')).toBe(true);
  expect(await activePath(page)).toBe('tally/currency.py');
  // Both landings round the eye point to a whole scrollTop, so they can differ by a pixel.
  await expect.poll(async () => Math.abs((await cursor.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
  await expect(page).toHaveScreenshot('viewed-above.png');
});
