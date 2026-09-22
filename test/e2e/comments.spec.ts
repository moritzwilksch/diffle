import { expect, expectAria, test } from './fixtures.js';
import { gotoFile, selectLines } from './browser.js';
import { readPrompt, readThreads } from './server.js';

test('comments on a line range and lists the thread in the panel', async ({ page, diffle }) => {
  await gotoFile(page, 'tally/ledger.py');
  await selectLines(page, 'tally/ledger.py', 3, 4);
  const composer = page.getByPlaceholder('Leave a comment…');
  await composer.fill('Say what counts as a refund here, not only in the parser.');
  await composer.press('Control+Enter');
  await expect(page.locator('aside').last()).toContainText('ledger.py');

  const threads = await readThreads(diffle.url);
  expect(threads).toHaveLength(1);
  expect(threads[0]?.anchor).toMatchObject({
    kind: 'line',
    path: 'tally/ledger.py',
    side: 'new',
    startLine: 3,
    endLine: 4,
  });
  await expect(page).toHaveScreenshot('comment.png');
  await expectAria(page.locator('aside').last(), 'threads-panel');
});

test('comments on a whole file and exports both threads as a prompt', async ({ page, diffle }) => {
  await gotoFile(page, 'tally/refunds.py');
  await page.keyboard.press('C');
  const composer = page.getByPlaceholder('Leave a comment…');
  await composer.fill('Consider folding this into `ledger.py`; it only has two callers.');
  await composer.press('Control+Enter');
  await gotoFile(page, 'tally/currency.py');
  await selectLines(page, 'tally/currency.py', 7, 7);
  await page.getByPlaceholder('Leave a comment…').fill('`KWD` gets three decimals above but no symbol here.');
  await page.getByPlaceholder('Leave a comment…').press('Control+Enter');

  await expect(page.locator('aside').last()).toContainText('refunds.py');
  await expect(page.locator('aside').last()).toContainText('currency.py');
  const prompt = await readPrompt(diffle.url);
  expect(prompt).toContain('KWD');
  // The prompt an agent receives for this review, quoted lines included; same in both schemes.
  if (test.info().project.name === 'light') expect(prompt).toMatchSnapshot('prompt.md');
  await expect(page).toHaveScreenshot('two-threads.png');
});

test('regression: deleting a thread needs a second click and confirmation expires', async ({ page, diffle }) => {
  await gotoFile(page, 'tally/ledger.py');
  await page.keyboard.press('C');
  await page.getByPlaceholder('Leave a comment…').fill('Keep this until deletion is confirmed.');
  await page.getByPlaceholder('Leave a comment…').press('Control+Enter');
  const remove = page.getByRole('button', { name: 'Delete this thread', exact: true });
  const confirm = page.getByRole('button', { name: 'Delete this thread? Click again to confirm', exact: true });
  await expect(remove).toBeVisible();
  await page.clock.install();
  await remove.click();
  await expect(confirm).toBeVisible();
  expect(await readThreads(diffle.url)).toHaveLength(1);
  await page.clock.fastForward(3100);
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(confirm).toBeVisible();
  expect(await readThreads(diffle.url)).toHaveLength(1);
  await confirm.click();
  await expect.poll(() => readThreads(diffle.url)).toEqual([]);
  await expect(page.locator('aside').last()).toContainText('No comments yet.');
});
