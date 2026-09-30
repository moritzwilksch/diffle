import { expect, test } from './fixtures.js';
import { gotoFile, viewed, collapsed } from './browser.js';

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
