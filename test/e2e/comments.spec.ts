import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clickLine, fixCommentDates, gotoFile, selectLines, settle } from './browser.js';
import { readPrompt, readThreads, seedReply, seedThreads } from './server.js';

function stableTargets(prompt: string): string {
  return prompt.replace(/^Target: `[^`]+`$/gm, 'Target: `[target]`').replace(/[ \t]+$/gm, '');
}

async function snapshotComments(page: Page, name: string) {
  await fixCommentDates(page);
  await expect(page).toHaveScreenshot(name);
}

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
  await expect(page.locator('aside').last()).toMatchAriaSnapshot({ name: 'threads-panel.aria.yml' });
  await snapshotComments(page, 'comment.png');
});

test('expanded Threads stays over the diff, remembers its scroll, and jumps to a comment', async ({ page, diffle }) => {
  const path = 'tally/ledger.py';
  const body = 'Jump to the last local thread.';
  await seedThreads(diffle.url, [
    ...Array.from({ length: 30 }, (_, index) => ({ path, startLine: 3, body: `Local thread ${index}` })),
    { path, startLine: 4, body },
  ]);
  await gotoFile(page, 'tally/currency.py');

  const sidebar = page.locator('aside').last();
  const sidebarList = sidebar.getByLabel('Threads list', { exact: true });
  await sidebar.getByRole('button', { name: 'Scroll Threads to bottom' }).click();
  await expect(sidebarList.getByText(body)).toBeInViewport();
  await sidebar.getByRole('button', { name: 'Scroll Threads to top' }).click();
  await expect(sidebarList).toHaveJSProperty('scrollTop', 0);

  await sidebar.getByRole('button', { name: 'Expand Threads' }).click();
  const overlay = page.getByRole('dialog', { name: 'Threads', exact: true });
  await expect(overlay).toBeVisible();
  const code = page.locator('.codeview');
  const diff = await code.boundingBox();
  const expanded = await overlay.boundingBox();
  expect(expanded?.x).toBe(diff?.x);
  expect(expanded?.width).toBe(diff?.width);
  expect(expanded!.width).toBeGreaterThan((await sidebar.boundingBox())!.width);

  const list = overlay.getByLabel('Threads list', { exact: true });
  await overlay.getByRole('button', { name: 'Scroll Threads to bottom' }).click();
  await expect(list.getByText(body)).toBeInViewport();
  await overlay.getByRole('button', { name: 'Scroll Threads to top' }).click();
  await expect(list).toHaveJSProperty('scrollTop', 0);
  const offset = await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2;
    return element.scrollTop;
  });
  expect(offset).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await page.keyboard.press('L');
  await expect(list).toHaveJSProperty('scrollTop', offset);
  await page.keyboard.press('L');
  await expect(overlay).toBeHidden();

  await sidebar.getByRole('button', { name: 'Expand Threads' }).click();
  await overlay.getByRole('button', { name: 'Scroll Threads to bottom' }).click();
  await list.getByText(body).click();
  await expect(overlay).toBeHidden();
  await expect(code.getByText(body)).toBeInViewport();
  await expect(code.locator('[data-column-number="4"][data-comment-line]')).toBeInViewport();
  await page.keyboard.press('L');
  await expect(list.getByText(body)).toBeInViewport();
});

test('collapses and expands all thread bodies in the sidebar', async ({ page, diffle }) => {
  const path = 'tally/ledger.py';
  const bodies = ['Keep the input signed.', 'Check the refund total.'];
  await seedThreads(
    diffle.url,
    bodies.map((body, index) => ({ path, startLine: 3 + index, body })),
  );
  await gotoFile(page, path);

  const sidebar = page.locator('aside').last();
  const list = sidebar.getByRole('region', { name: 'Threads list' });
  await expect(list.getByText(bodies[0]!)).toBeVisible();
  await sidebar.getByRole('button', { name: 'Collapse all threads' }).click();
  for (const body of bodies) await expect(list.getByText(body)).toBeHidden();
  await expect(list.getByRole('button', { name: 'Resolve thread', exact: true })).toHaveCount(2);
  await sidebar.getByRole('button', { name: 'Expand all threads' }).click();
  for (const body of bodies) await expect(list.getByText(body)).toBeVisible();
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
  expect(stableTargets(prompt)).toMatchSnapshot('prompt.md');
  await snapshotComments(page, 'two-threads.png');
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

test('resolves and reopens a thread from the comments panel', async ({ page, diffle }) => {
  await seedThreads(diffle.url, [{ path: 'tally/ledger.py', body: 'Keep the review history.' }]);
  const sidebar = page.locator('aside').last();
  await sidebar.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await expect(sidebar).toContainText('Every thread is resolved.');
  await expect.poll(async () => (await readThreads(diffle.url))[0]?.resolved).toBe(true);
  await sidebar.getByText('Show 1 resolved', { exact: true }).click();
  await expect(sidebar.getByText('Keep the review history.')).toBeVisible();
  await sidebar.getByRole('button', { name: 'Reopen thread', exact: true }).click();
  await expect.poll(async () => (await readThreads(diffle.url))[0]?.resolved).toBe(false);
});

test('edits only the latest reviewer message in a local thread', async ({ page, diffle }) => {
  const path = 'tally/ledger.py';
  const [thread] = await seedThreads(diffle.url, [{ path, startLine: 4, body: 'Original reviewer comment' }]);
  await gotoFile(page, path);
  const code = page.locator('.codeview');
  const edit = code.getByRole('button', { name: 'Edit (e)', exact: true });
  await expect(edit).toHaveCount(1);

  await seedReply(diffle.url, thread!.id, { body: 'Agent response', author: 'agent' });
  await expect(code.getByText('Agent response')).toBeVisible();
  await expect(edit).toHaveCount(0);

  await seedReply(diffle.url, thread!.id, { body: 'My follow-up' });
  await expect(code.getByText('My follow-up')).toBeVisible();
  await expect(edit).toHaveCount(1);
  await edit.click();
  const editor = code.getByRole('textbox');
  await expect(editor).toHaveValue('My follow-up');
  await editor.fill('Updated reviewer message');
  await editor.press('Control+Enter');
  await expect(code.getByText('Updated reviewer message')).toBeVisible();
  await expect(code.getByText('Agent response')).toBeVisible();
  await expect(code.getByText('Original reviewer comment')).toBeVisible();
});

test.describe('a stale local thread', () => {
  test.use({ revs: ['working'] });

  test('keeps stale threads in the sidebar until bulk deletion is confirmed', async ({ page, diffle, repo }) => {
    const path = 'tally/refunds.py';
    const file = join(repo, path);
    const [first, second, live] = await seedThreads(diffle.url, [
      { path, startLine: 18, body: 'Discuss the original refund logic.' },
      { path, startLine: 18, body: 'Check the original rounding.' },
      { path, body: 'Keep this file thread.' },
    ]);
    await gotoFile(page, path);
    const code = page.locator('.codeview');
    const body = code.getByText('Discuss the original refund logic.');
    await expect(body).toBeVisible();

    const lines = (await readFile(file, 'utf8')).split('\n');
    lines[17] = '    # The original refund logic has moved.';
    await writeFile(file, lines.join('\n'));
    const reloaded = await page.request.post(new URL('api/reload', diffle.url).href);
    expect(reloaded.ok()).toBe(true);
    const staleIds = [first!.id, second!.id].sort();
    await expect
      .poll(async () =>
        (await readThreads(diffle.url))
          .filter((thread) => thread.stale)
          .map((thread) => thread.id)
          .sort(),
      )
      .toEqual(staleIds);
    await expect(body).toHaveCount(0);
    await expect(code.locator('[data-thread-marker]')).toHaveCount(0);
    const sidebar = page.locator('aside').last();
    await expect(sidebar.getByText('Discuss the original refund logic.')).toBeVisible();
    const stale = sidebar.locator('[class~="group/thread"]').filter({ hasText: 'Discuss the original refund logic.' });
    await stale.getByRole('button', { name: 'Reply', exact: true }).click();
    const reply = stale.getByPlaceholder('Reply…');
    await expect(reply).toBeFocused();
    await expect(code.getByPlaceholder('Reply…')).toHaveCount(0);
    await reply.fill('Please restore the original refund logic.');
    await reply.press('Control+Enter');
    await expect(stale.getByText('Please restore the original refund logic.')).toBeVisible();
    await expect
      .poll(
        async () => (await readThreads(diffle.url)).find((thread) => thread.id === first!.id)?.messages.at(-1)?.body,
      )
      .toBe('Please restore the original refund logic.');
    await sidebar.getByRole('button', { name: 'Delete all stale', exact: true }).click();
    expect(await readThreads(diffle.url)).toHaveLength(3);
    await sidebar.getByRole('button', { name: 'Delete all stale threads? Click again to confirm' }).click();
    await expect.poll(async () => (await readThreads(diffle.url)).map((thread) => thread.id)).toEqual([live!.id]);
    await expect(sidebar.getByText('Discuss the original refund logic.')).toHaveCount(0);
    await expect(sidebar.getByText('Keep this file thread.')).toBeVisible();
  });
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
  await settle(page);
  await gotoFile(page, 'tally/ledger.py');
  await selectLines(page, 'tally/ledger.py', 3, 4);
  await expect(composer).toHaveValue('A long thought, half written.');
  await composer.press('Control+Enter');
  await expect.poll(async () => (await readThreads(diffle.url)).length).toBe(1);

  const code = page.locator('.codeview');
  const reply = code.getByPlaceholder('Reply…');
  await code.getByRole('button', { name: 'Reply', exact: true }).click();
  await reply.fill('And one more thing.');
  await reply.press('Escape');
  await code.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(reply).toHaveValue('And one more thing.');
  await reply.press('Escape');

  const sidebar = page.getByRole('region', { name: 'Threads list' });
  await sidebar.getByRole('button', { name: 'Reply', exact: true }).click();
  const sidebarReply = sidebar.getByPlaceholder('Reply…');
  await expect(sidebarReply).toHaveValue('And one more thing.');
  await expect(reply).toHaveCount(0);
  await sidebarReply.press('Escape');

  // Posting forgets the text: the same lines open an empty composer.
  await selectLines(page, 'tally/ledger.py', 3, 4);
  await expect(composer).toHaveValue('');
  await composer.press('Escape');
  await page.keyboard.press('C');
  await expect(composer).toHaveValue('About the whole file.');
});

test('marks a thread the agent opened in its header, in the panel and inline', async ({ page, diffle }) => {
  await seedThreads(diffle.url, [
    {
      path: 'tally/ledger.py',
      startLine: 3,
      endLine: 4,
      body: 'The docstring names `refund` but not how a refund is signed.',
      author: 'agent',
    },
  ]);
  await gotoFile(page, 'tally/ledger.py');
  await expect(page.locator('aside').last()).toContainText('agent');
  await expect(page.locator('aside').last()).toMatchAriaSnapshot({ name: 'agent-threads-panel.aria.yml' });
  await snapshotComments(page, 'agent-thread.png');
});

test('shows agent and reviewer replies in order in the Threads panel', async ({ page, diffle }) => {
  const [thread] = await seedThreads(diffle.url, [
    { path: 'tally/currency.py', startLine: 7, body: '`KWD` gets three decimals above but no symbol here.' },
  ]);
  await seedReply(diffle.url, thread!.id, { body: 'Added `KD` to `_SYMBOLS`.', author: 'agent' });
  await seedReply(diffle.url, thread!.id, { body: 'Thanks.' });
  await gotoFile(page, 'tally/currency.py');
  const messages = ['KWD gets three decimals above but no symbol here.', 'Added KD to _SYMBOLS.', 'Thanks.'];
  await expect(page.locator('.codeview').getByText('Thanks.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Threads list' }).getByRole('paragraph')).toHaveText(messages);
  await snapshotComments(page, 'agent-reply.png');
});

test('exports agent messages with an (agent) prefix in the prompt', async ({ diffle }) => {
  const [opened, reviewed] = await seedThreads(diffle.url, [
    {
      path: 'tally/refunds.py',
      body: 'Consider folding this into `ledger.py`; it only has two callers.',
      author: 'agent',
    },
    { path: 'tally/currency.py', startLine: 7, body: '`KWD` gets three decimals above but no symbol here.' },
  ]);
  await seedReply(diffle.url, opened!.id, { body: 'Agreed, in a follow-up.' });
  await seedReply(diffle.url, reviewed!.id, { body: 'Added `KD` to `_SYMBOLS`.', author: 'agent' });
  expect(stableTargets(await readPrompt(diffle.url))).toMatchSnapshot('agent-prompt.md');
});
