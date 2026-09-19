// What a reviewer does: comment, mark viewed, search, switch comparison, ask the language
// server. Each scenario asserts the state it changed, then a screenshot shows it.
import { join } from 'node:path';
import { expect, expectAria, test } from './fixtures.js';
import {
  collapsed,
  filePaths,
  gotoFile,
  hoverSymbol,
  readPrompt,
  readThreads,
  REPO_ROOT,
  selectLines,
  viewed,
  waitForLsp,
} from './harness.js';

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

test('marks a file viewed, collapses it and moves on', async ({ page }) => {
  await gotoFile(page, 'scripts/build.bat');
  await page.keyboard.press('v');
  expect(await viewed(page, 'scripts/build.bat')).toBe(true);
  expect(await collapsed(page, 'scripts/build.bat')).toBe(true);
  await expect(page.locator('file-tree-container')).toContainText('✓');
  await expect(page).toHaveScreenshot('viewed.png');
});

test('searches the current file and highlights the matches', async ({ page }) => {
  await gotoFile(page, 'tally/ledger.py');
  await page.keyboard.press('/');
  const search = page.locator('[data-content-search]');
  await search.fill('refund');
  await search.press('Enter');
  await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
  await expect(page).toHaveScreenshot('search.png');
});

test('opens the keyboard help', async ({ page }) => {
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveScreenshot('help.png');
  await expectAria(dialog, 'help');
});

test('opens the mode picker on the current comparison', async ({ page }) => {
  await page.keyboard.press('m');
  const picker = page.locator('#mode-picker');
  await expect(picker).toBeVisible();
  await expect(page).toHaveScreenshot('mode-picker.png');
  await expectAria(picker, 'mode-picker');
});

test('masks the version in the settings dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The version changes with every release; everything else in the dialog is stable.
  await expect(page).toHaveScreenshot('settings.png', { mask: [page.getByTitle('Installed diffle version')] });
});

test.describe('working mode', () => {
  test.use({ revs: ['working'] });

  test('shows the staged, unstaged and untracked changes', async ({ page }) => {
    await expect(page.locator('header')).toContainText('3 files');
    expect(await filePaths(page)).toEqual(['notes/todo.md', 'tally/refunds.py', 'README.md']);
    await expect(page).toHaveScreenshot('working.png');
  });
});

test.describe('two-dot comparison', () => {
  test.use({ revs: ['main..feature/refunds'] });

  test("includes main's own fix, which the merge-base view leaves out", async ({ page }) => {
    await expect(page.locator('header')).toContainText('18 files');
    expect(await filePaths(page)).toContain('README.md');
  });
});

test.describe('with a language server', () => {
  // The fake server from the unit tests: it answers hover with a fixed signature, so the tooltip
  // exercises the real bridge, request and rendering without a Python toolchain.
  test.use({
    args: [
      '--lsp',
      `python=${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}`,
    ],
    // The diff's other languages are resolved on PATH; a bare one keeps a developer's installed
    // servers out of the screenshot.
    env: { PATH: '/usr/bin:/bin' },
  });

  test('shows a hover tooltip for a symbol', async ({ page, diffle }) => {
    await gotoFile(page, 'tally/ledger.py');
    await waitForLsp(diffle.url);
    await expect(page.getByLabel(/Language servers/)).toBeVisible();
    const tooltip = page.getByRole('tooltip');
    // The first hover can land while the bridge is still opening the document; hover again then.
    await expect(async () => {
      await hoverSymbol(page, 'round_amount', { path: 'tally/ledger.py' });
      await expect(tooltip).toContainText('def f() -> None', { timeout: 2000 });
    }).toPass({ timeout: 10000 });
    await expect(tooltip).toHaveScreenshot('hover.png');
  });
});
