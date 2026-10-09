import { expect, test } from './fixtures.js';
import { clickLine, gotoFile, selectLines } from './browser.js';
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
  await expect(page.locator('aside').last()).toMatchAriaSnapshot({ name: 'threads-panel.aria.yml' });
});

test("regression: pressing the cursor's line number comments on that line", async ({ page, diffle }) => {
  await gotoFile(page, 'tally/ledger.py');
  await clickLine(page, 'tally/ledger.py', 5);
  // The viewer reads a press on the one selected line as unselecting it; it must open the composer.
  await selectLines(page, 'tally/ledger.py', 5, 5);
  const composer = page.getByPlaceholder('Leave a comment…');
  await expect(composer).toBeVisible();
  await composer.fill('Name the unit.');
  await composer.press('Control+Enter');
  await expect
    .poll(async () => (await readThreads(diffle.url))[0]?.anchor)
    .toMatchObject({
      kind: 'line',
      path: 'tally/ledger.py',
      startLine: 5,
      endLine: 5,
    });
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
  // The prompt an agent receives for this review, quoted lines included.
  expect(prompt).toMatchSnapshot('prompt.md');
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

test('regression: closing a composer keeps its text until the comment is posted', async ({ page, diffle }) => {
  await gotoFile(page, 'tally/ledger.py');
  await selectLines(page, 'tally/ledger.py', 3, 4);
  const composer = page.getByPlaceholder('Leave a comment…');
  await composer.fill('A long thought, half written.');
  await composer.press('Escape');
  await expect(composer).toBeHidden();

  // Another target starts empty; the first comes back, across a reload too.
  await page.keyboard.press('C');
  await expect(composer).toHaveValue('');
  await composer.fill('About the whole file.');
  await composer.press('Escape');
  await page.reload();
  await gotoFile(page, 'tally/ledger.py');
  await selectLines(page, 'tally/ledger.py', 3, 4);
  await expect(composer).toHaveValue('A long thought, half written.');
  await composer.press('Control+Enter');
  await expect.poll(async () => (await readThreads(diffle.url)).length).toBe(1);

  const reply = page.getByPlaceholder('Reply…');
  await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
  await reply.fill('And one more thing.');
  await reply.press('Escape');
  await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
  await expect(reply).toHaveValue('And one more thing.');

  // Posting forgets the text: the same lines open an empty composer.
  await reply.press('Escape');
  await selectLines(page, 'tally/ledger.py', 3, 4);
  await expect(composer).toHaveValue('');
  await composer.press('Escape');
  await page.keyboard.press('C');
  await expect(composer).toHaveValue('About the whole file.');
});
