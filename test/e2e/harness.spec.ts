// The verbs in browser.ts encode where the UI lives. These scenarios pin that encoding, so markup
// changes break here instead of in an agent's screenshot script.
import { expect, test } from './fixtures.js';
import {
  activePath,
  collapsed,
  filePaths,
  gotoFile,
  header,
  openModePicker,
  selectLines,
  setViewed,
  toggleCollapse,
  viewed,
} from './browser.js';

test('reads and drives a file far below the viewport without navigating there first', async ({ page }) => {
  const paths = await filePaths(page);
  expect(paths.at(-1)).toBe('VERSION');
  expect(await activePath(page)).toBe(paths[0]);

  // Header verbs walk there and leave the collapse state alone.
  expect(await collapsed(page, 'VERSION')).toBe(false);
  expect(await activePath(page)).toBe('VERSION');

  await gotoFile(page, 'tally/ledger.py');
  await selectLines(page, 'VERSION', 1, 1);
  await expect(page.getByPlaceholder('Leave a comment…')).toBeVisible();
});

test('toggles collapse twice, viewed on and off, and opens the mode picker', async ({ page }) => {
  await gotoFile(page, 'tally/refunds.py');
  await expect(await header(page, 'tally/refunds.py')).toContainText('refunds.py');

  await toggleCollapse(page, 'tally/refunds.py');
  await expect.poll(() => collapsed(page, 'tally/refunds.py')).toBe(true);
  // The pointer rests on the button, whose title the tooltip lifted; the second toggle must still find it.
  await toggleCollapse(page, 'tally/refunds.py');
  await expect.poll(() => collapsed(page, 'tally/refunds.py')).toBe(false);

  await setViewed(page, 'tally/refunds.py', true);
  await expect.poll(() => viewed(page, 'tally/refunds.py')).toBe(true);
  await setViewed(page, 'tally/refunds.py', false);
  await expect.poll(() => viewed(page, 'tally/refunds.py')).toBe(false);

  await expect(await openModePicker(page)).toBeVisible();
});

test('names why a line cannot be selected', async ({ page }) => {
  await expect(selectLines(page, 'assets/logo.png', 1, 1)).rejects.toThrow('renders no lines');
  await expect(selectLines(page, 'tally/cli.py', 1, 1)).rejects.toThrow(/line 1 not found .* rendered lines: 21,/);
  await expect(selectLines(page, 'nope.py', 1, 1)).rejects.toThrow('not a changed file: nope.py');
});
