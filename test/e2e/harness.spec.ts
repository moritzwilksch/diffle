// The verbs in browser.ts encode where the UI lives. These scenarios pin that encoding, so markup
// changes break here instead of in an agent's screenshot script.
import { expect, test } from './fixtures.js';
import {
  activePath,
  clickLine,
  collapsed,
  filePaths,
  gotoFile,
  header,
  openModePicker,
  selectLines,
  setViewed,
  toggleCollapse,
  viewed,
  waitForHighlight,
  walkToFile,
} from './browser.js';
import { readThreads } from './server.js';

test('reads and drives a file far below the viewport without navigating there first', async ({ page, diffle }) => {
  const paths = await filePaths(page);
  expect(paths.at(-1)).toBe('VERSION');
  expect(await activePath(page)).toBe(paths[0]);

  // Header verbs walk there and leave the collapse state alone.
  expect(await collapsed(page, 'VERSION')).toBe(false);
  expect(await activePath(page)).toBe('VERSION');

  await gotoFile(page, 'tally/ledger.py');
  await selectLines(page, 'VERSION', 1, 1);
  const composer = page.getByPlaceholder('Leave a comment…');
  await composer.fill('Bump it.');
  await composer.press('Control+Enter');
  await expect.poll(async () => (await readThreads(diffle.url)).length).toBe(1);
  const [thread] = await readThreads(diffle.url);
  expect(thread?.anchor).toMatchObject({ kind: 'line', path: 'VERSION', startLine: 1, endLine: 1 });
  expect(thread?.messages[0]?.body).toBe('Bump it.');
});

test('toggles collapse twice and viewed on and off', async ({ page }) => {
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
});

test('walks, clicks a line, waits for highlighting and opens the mode picker', async ({ page }) => {
  await walkToFile(page, 'tally/ledger.py');
  expect(await activePath(page)).toBe('tally/ledger.py');
  await waitForHighlight(page, 'tally/ledger.py');
  await clickLine(page, 'tally/ledger.py', 5);
  expect(await activePath(page)).toBe('tally/ledger.py');
  await expect(await openModePicker(page)).toBeVisible();
});

test('names why a line cannot be selected', async ({ page }) => {
  await expect(selectLines(page, 'assets/logo.png', 1, 1)).rejects.toThrow('renders no lines');
  await expect(selectLines(page, 'tally/cli.py', 1, 1)).rejects.toThrow(/line 1 not found .* rendered lines: 21,/);
  await expect(selectLines(page, 'nope.py', 1, 1)).rejects.toThrow('not a changed file: nope.py');
});
