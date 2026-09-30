import { expect, test } from './fixtures.js';
import { gotoFile } from './browser.js';

test('searches the current file and highlights the matches', async ({ page }) => {
  await gotoFile(page, 'tally/ledger.py');
  await page.keyboard.press('/');
  const search = page.locator('[data-content-search]');
  await search.fill('refund');
  await search.press('Enter');
  await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
  await expect(page).toHaveScreenshot('search.png');
});

test('regression: opening and closing local search does not accumulate scroll drift', async ({ page }) => {
  await gotoFile(page, 'tally/ledger.py');
  const scroller = page.locator('.codeview');
  const before = await scroller.evaluate((element) => element.scrollTop);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('/');
    await expect(page.locator('[data-content-search]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-content-search]')).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await scroller.evaluate((element) => element.scrollTop)) - before))
      .toBeLessThanOrEqual(1);
  }
});

test('regression: an unsubmitted search keeps its draft and focus after its header is virtualized', async ({
  page,
}) => {
  await gotoFile(page, 'tally/ledger.py');
  await page.keyboard.press('/');
  const input = page.locator('[data-content-search]');
  await input.fill('unfinished refund query');
  const scroller = page.locator('.codeview');
  const before = await scroller.evaluate((element) => element.scrollTop);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(input).toHaveCount(0);
  await scroller.evaluate((element, top) => {
    element.scrollTop = top;
  }, before);
  await expect(input).toHaveValue('unfinished refund query');
  await expect(input).toBeFocused();
  await expect
    .poll(async () => Math.abs((await scroller.evaluate((element) => element.scrollTop)) - before))
    .toBeLessThanOrEqual(1);
});

test('regression: a filename filter survives moving focus into the diff', async ({ page }) => {
  await gotoFile(page, 'tally/ledger.py');
  const filter = page.locator('file-tree-container [data-file-tree-search-input]');
  await filter.fill('ledger');
  await page.locator('.codeview').click({ position: { x: 200, y: 100 } });
  await expect(page.locator('.codeview')).toBeFocused();
  await expect(filter).toHaveValue('ledger');
  await expect(page.locator('file-tree-container [data-item-type="file"]')).toHaveCount(2);
});
