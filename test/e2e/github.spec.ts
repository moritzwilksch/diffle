import { clickCentred, gotoFile, selectLines, settle } from './browser.js';
import { expect, test as base } from './fixtures.js';
import { githubFixture, path } from './github-fixture.js';
import { seedReply, seedThreads, startDiffle } from './server.js';

const test = base.extend<{ github: Awaited<ReturnType<typeof githubFixture>> }>({
  github: async ({ repo }, use) => {
    const github = await githubFixture(repo);
    try {
      await use(github);
    } finally {
      await github.close();
    }
  },
  env: async ({ github }, use) => use(github.env),
});

test.use({ revs: ['pr', '7'], args: ['--no-checkout'] });

test('shows dated GitHub comments in code and toggles the card and line icon', async ({ page }) => {
  const panel = page.getByRole('region', { name: 'GitHub comments' });
  await expect(panel.getByText('This currency needs three places.')).toBeVisible();
  await gotoFile(page, path);
  await expect(page.locator('.codeview').getByText('Why does this use three places?')).toBeVisible();
  const thread = page
    .getByRole('article', { name: 'GitHub thread in code' })
    .filter({ hasText: 'Why does this use three places?' });
  await expect(thread.getByText('Why does this use three places?')).toBeVisible();
  await expect(thread.getByText('This currency needs three places.')).toBeVisible();
  await expect(thread.locator('time')).toHaveText(['May 31, 2024', 'May 31, 2024']);
  await expect(
    panel.locator('article').filter({ hasText: 'This currency needs three places.' }).locator('time'),
  ).toHaveText('May 31, 2024');

  await clickCentred(thread.getByText('Why does this use three places?'));
  await expect(thread).toHaveCount(0);
  await page
    .locator('[data-column-number="20"]')
    .getByRole('button', { name: 'Open GitHub thread', exact: true })
    .click();
  await expect(thread.getByText('This currency needs three places.')).toBeVisible();
});

test('keeps a long inline GitHub comment inside its split diff column', async ({ page }) => {
  const prose = `Long comment ${'wrapped words '.repeat(25)}end of paragraph`;
  const literal = `const value = '${'long'.repeat(180)}';`;
  await gotoFile(page, path);
  const file = page.locator('.codeview diffs-container').filter({ has: page.locator(`[data-path="${path}"]`) });
  const thread = file.getByRole('article', { name: 'GitHub thread in code' });
  await clickCentred(thread.getByRole('button', { name: 'Reply', exact: true }));
  const reply = thread.getByRole('textbox', { name: 'GitHub reply' });
  await reply.fill([prose, '', '```text', literal, '```'].join('\n'));
  await reply.press('Control+Enter');
  const paragraph = thread.getByText(/^Long comment/);
  const block = thread.locator('pre').filter({ hasText: /^const value/ });
  await expect(paragraph).toBeVisible();
  await expect(block).toBeVisible();

  for (const overflow of ['wrap', 'scroll']) {
    await expect(file.locator(`pre[data-diff-type="split"][data-overflow="${overflow}"]`)).toBeAttached();
    const oldColumn = file.locator('[data-deletions] [data-content]');
    const newColumn = file.locator('[data-additions] [data-content]');
    await expect
      .poll(async () => {
        const oldSide = (await oldColumn.boundingBox())!;
        const newSide = (await newColumn.boundingBox())!;
        const diff = (await file.boundingBox())!;
        const card = (await thread.boundingBox())!;
        return (
          oldSide.width > diff.width / 3 &&
          newSide.width > diff.width / 3 &&
          card.x >= newSide.x &&
          card.x + card.width <= diff.x + diff.width
        );
      })
      .toBe(true);
    await expect.poll(() => paragraph.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(
      await block.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        return element.scrollLeft;
      }),
    ).toBeGreaterThan(0);
    if (overflow === 'wrap') {
      await page.keyboard.press('z');
      await page.keyboard.press('w');
    }
  }
});

test('replies, changes resolution from both panels, collapses threads, and edits the pending review', async ({
  page,
  github,
}) => {
  const panel = page.getByRole('region', { name: 'GitHub comments' });
  const active = panel.locator('details').filter({ hasText: 'Why does this use three places?' });
  await active.getByRole('button', { name: 'author' }).click();
  const code = page
    .getByRole('article', { name: 'GitHub thread in code' })
    .filter({ hasText: 'Why does this use three places?' });
  await expect(code.getByText('This currency needs three places.')).toBeVisible();
  await clickCentred(code.getByRole('button', { name: 'Reply', exact: true }));
  const reply = code.getByRole('textbox', { name: 'GitHub reply' });
  await reply.fill('Thanks for clarifying.');
  await reply.press('Control+Enter');
  await expect(active.getByText('Thanks for clarifying.')).toBeVisible();
  await expect(code.getByText('Thanks for clarifying.')).toBeVisible();

  await active.getByRole('button', { name: 'Reply', exact: true }).click();
  await active.getByRole('textbox', { name: 'GitHub reply' }).fill('Remove this draft.');
  await active.getByRole('button', { name: 'Add reply to review' }).click();
  await expect(code.getByText('Remove this draft.')).toBeVisible();

  await clickCentred(code.getByRole('button', { name: 'Resolve thread', exact: true }));
  const marker = page.locator('[data-column-number="20"]').getByRole('button', { name: 'Open resolved GitHub thread' });
  await expect(code).toHaveCount(0);
  await expect(marker).toBeVisible();
  await active.getByRole('button', { name: 'Unresolve thread' }).click();
  await expect(code.getByRole('button', { name: 'Resolve thread', exact: true })).toBeVisible();
  await active.getByRole('button', { name: 'Resolve thread', exact: true }).click();
  await marker.click();
  await clickCentred(code.getByRole('button', { name: 'Unresolve thread' }));
  await expect(active.getByRole('button', { name: 'Resolve thread', exact: true })).toBeVisible();

  const resolved = panel.locator('details').filter({ hasText: 'Resolved discussion' });
  const outdated = panel.locator('details').filter({ hasText: 'Outdated discussion' });
  await panel.getByRole('button', { name: 'Collapse resolved' }).click();
  await expect(resolved).toHaveJSProperty('open', false);
  await expect(outdated).toHaveJSProperty('open', true);
  await panel.getByRole('button', { name: 'Collapse outdated' }).click();
  await expect(outdated).toHaveJSProperty('open', false);
  await expect(active).toHaveJSProperty('open', true);
  await resolved.locator('summary').click();
  await expect(resolved.getByText('Resolved discussion')).toBeVisible();

  await page.getByRole('button', { name: 'Review changes' }).click();
  const review = page.getByRole('dialog', { name: 'Review pull request #7' });
  await review.getByRole('textbox', { name: 'General comment' }).fill('General review summary.');
  const pending = review.getByRole('region', { name: 'Pending GitHub comments' });
  await expect(pending.getByRole('listitem')).toHaveCount(2);
  const replyItem = pending.getByRole('listitem').filter({ hasText: 'Thanks for clarifying.' });
  await replyItem.getByRole('button', { name: 'Edit pending comment' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit pending GitHub comment' });
  const comment = editor.getByRole('textbox', { name: 'Comment' });
  await expect(comment).toHaveValue('Thanks for clarifying.');
  await comment.fill('Thanks for explaining the precision.');
  await comment.press('Control+Enter');
  await expect(pending.getByText('Thanks for explaining the precision.')).toBeVisible();
  await pending
    .getByRole('listitem')
    .filter({ hasText: 'Remove this draft.' })
    .getByRole('button', { name: 'Delete pending comment' })
    .click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete pending GitHub comment' });
  await confirm.getByRole('button', { name: 'Delete comment' }).click();
  await expect(pending.getByRole('listitem')).toHaveCount(1);
  await expect(pending.getByText('Thanks for explaining the precision.')).toBeVisible();
  await expect(review.getByRole('textbox', { name: 'General comment' })).toHaveValue('General review summary.');
  await review.getByRole('button', { name: 'Submit review' }).click();
  await expect(review).toHaveCount(0);
  expect(github.submitted).toEqual([
    { summary: 'General review summary.', comments: ['Thanks for explaining the precision.'] },
  ]);
  await expect(code.getByText('Thanks for explaining the precision.')).toBeVisible();
  await expect(code.getByRole('button', { name: 'Edit pending comment' })).toHaveCount(0);
});

test('restores open cards and clickable GitHub and local gutter markers after a server restart', async ({
  page,
  repo,
  revs,
  args,
  diffle,
  github,
}) => {
  const [resolved, resolvedFile, local] = await seedThreads(diffle.url, [
    { path, startLine: 7, body: 'Resolved local comment' },
    { path, body: 'Resolved file comment' },
    { path, startLine: 8, body: 'Open local comment' },
  ]);
  const conversation = await seedReply(diffle.url, local!.id, {
    body: 'Local reply with its own date',
    author: 'agent',
  });
  for (const thread of [resolved!, resolvedFile!]) {
    const response = await page.request.put(new URL(`api/threads/${thread.id}/resolved`, diffle.url).href, {
      data: { resolved: true },
    });
    expect(response.ok()).toBe(true);
  }
  const code = page.locator('.codeview');
  const gutter = (line: number) => code.locator(`[data-column-number="${line}"]`);
  const name = (status: string, origin: string) => `Open ${status} ${origin} thread`;
  const resolvedGithub = gutter(18).getByRole('button', { name: name('resolved', 'GitHub') });
  const resolvedLocal = gutter(7).getByRole('button', { name: name('resolved', 'local') });
  await gotoFile(page, path);
  await expect(code.getByText('Resolved discussion')).toHaveCount(0);
  await expect(resolvedGithub).toBeVisible();
  const iconBox = (await resolvedGithub.boundingBox())!;
  const numberBox = (await gutter(18)
    .filter({ has: page.getByRole('button', { name: name('resolved', 'GitHub') }) })
    .locator('[data-line-number-content]')
    .boundingBox())!;
  expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(numberBox.x + 1);
  expect(iconBox.y + iconBox.height / 2).toBeGreaterThanOrEqual(numberBox.y);
  expect(iconBox.y + iconBox.height / 2).toBeLessThanOrEqual(numberBox.y + numberBox.height);
  await resolvedGithub.click();
  await expect(code.getByText('Resolved discussion')).toBeVisible();

  await diffle.stop();
  await expect(page.getByText('Lost the connection to the diffle server.', { exact: false })).toBeVisible();
  github.addReply('Reply arrived while the server was down.');
  const restarted = await startDiffle({
    repo,
    revs,
    args: [...args, '--port', new URL(diffle.url).port],
    env: github.env,
  });
  try {
    const arrived = 'Reply arrived while the server was down.';
    await expect(page.getByRole('region', { name: 'GitHub comments' }).getByText(arrived)).toBeVisible({
      timeout: 15_000,
    });
    await gotoFile(page, path);
    await expect(code.getByText(arrived)).toBeVisible();
    await expect(code.getByText('Open local comment')).toBeVisible();
    for (const message of conversation.messages) {
      const date = code.locator('[class~="group/message"]').filter({ hasText: message.body }).locator('time');
      await expect(date).toBeVisible();
      await expect(date).toHaveAttribute('datetime', new Date(message.createdAt).toISOString());
    }
    await expect(code.getByText('Resolved discussion')).toHaveCount(0);
    await expect(code.getByText('Outdated discussion')).toHaveCount(0);
    await expect(code.getByRole('button', { name: /outdated GitHub thread/ })).toHaveCount(0);
    const outdated = page
      .getByRole('region', { name: 'GitHub comments' })
      .locator('details')
      .filter({ hasText: 'Outdated discussion' });
    await expect(outdated.getByText('Outdated discussion')).toBeVisible();
    await expect(outdated.getByRole('button', { name: 'reviewer' })).toHaveCount(0);
    await expect(code.getByText('Resolved local comment')).toHaveCount(0);
    await resolvedGithub.click();
    await expect(code.getByText('Resolved discussion')).toBeVisible();
    await clickCentred(code.getByText('Open local comment'));
    await expect(code.getByText('Open local comment')).toHaveCount(0);
    await gutter(8).getByRole('button', { name: 'Open local thread', exact: true }).click();
    await expect(code.getByText('Local reply with its own date')).toBeVisible();
    await resolvedLocal.click();
    await expect(code.getByText('Resolved local comment')).toBeVisible();
    await gutter(7).getByRole('button', { name: 'Collapse resolved local thread' }).click();
    await expect(code.getByText('Resolved local comment')).toHaveCount(0);
    const fileMarker = code
      .getByRole('button', { name: 'Open resolved local thread' })
      .and(code.locator('button:not([data-thread-marker])'));
    await fileMarker.click();
    await expect(code.getByText('Resolved file comment')).toBeVisible();
  } finally {
    await restarted.stop();
  }
});

test('remembers both comment destinations in the browser session', async ({ page }) => {
  const destination = page.getByRole('combobox', { name: 'Comment destination' });
  await gotoFile(page, path);
  await selectLines(page, path, 5, 5);
  await destination.selectOption('github');
  await page.keyboard.press('Escape');
  await selectLines(page, path, 6, 6);
  await expect(destination).toHaveValue('github');
  await page.reload();
  await settle(page);
  await gotoFile(page, path);
  await selectLines(page, path, 7, 7);
  await expect(destination).toHaveValue('github');
  const composer = page.getByPlaceholder('Leave a comment…');
  await composer.fill('Draft added from the keyboard.');
  await composer.press('Control+Enter');
  await expect(
    page.getByRole('region', { name: 'GitHub comments' }).getByText('Draft added from the keyboard.'),
  ).toBeVisible();
  const inline = page
    .getByRole('article', { name: 'GitHub thread in code' })
    .filter({ hasText: 'Draft added from the keyboard.' });
  await clickCentred(inline.getByRole('button', { name: 'Edit pending comment' }));
  const edit = page.getByRole('dialog', { name: 'Edit pending GitHub comment' });
  await expect(edit.getByRole('textbox', { name: 'Comment' })).toHaveValue('Draft added from the keyboard.');
  await edit.getByRole('textbox', { name: 'Comment' }).fill('Edited inline.');
  await edit.getByRole('button', { name: 'Save comment' }).click();
  await expect(page.getByRole('region', { name: 'GitHub comments' }).getByText('Edited inline.')).toBeVisible();
  await selectLines(page, path, 8, 8);
  await expect(destination).toHaveValue('github');
  await destination.selectOption('local');
  await page.keyboard.press('Escape');
  await selectLines(page, path, 9, 9);
  await expect(destination).toHaveValue('local');
});
