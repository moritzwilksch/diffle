import { expect, test } from './fixtures.js';
import { filePaths, waitForHighlight } from './browser.js';

test.describe('working mode', () => {
  test.use({ revs: ['working'] });

  test('shows the staged, unstaged and untracked changes', async ({ page }) => {
    await expect(page.locator('header')).toContainText('4 files');
    expect(await filePaths(page)).toEqual(['assets/logo.png', 'notes/todo.md', 'tally/refunds.py', 'README.md']);
    await waitForHighlight(page, 'tally/refunds.py');
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

test.describe('single commit', () => {
  test.use({ revs: ['HEAD^!'] });

  test('shows the commit against its parent, with its subject', async ({ page }) => {
    const header = page.locator('header');
    await expect(header).toContainText('fix(cli): report an empty ledger instead of crashing');
    await expect(header).toContainText('1 files');
    expect(await filePaths(page)).toEqual(['tally/cli.py']);
    await waitForHighlight(page, 'tally/cli.py');
    await expect(page).toHaveScreenshot('commit.png');
  });

  test('steps to the parent and back toward HEAD', async ({ page }) => {
    const header = page.locator('header');
    const previous = page.getByRole('button', { name: 'Previous commit' });
    const next = page.getByRole('button', { name: 'Next commit' });
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(header).toContainText('chore: regenerate the client, refresh the lockfile and the logo');
    await expect(next).toBeEnabled();
    await page.keyboard.press('>');
    await expect(header).toContainText('fix(cli): report an empty ledger instead of crashing');
    await expect(next).toBeDisabled();
  });

  test('picks another commit from the compare menu', async ({ page }) => {
    await page.keyboard.press('m');
    await page.keyboard.press('5');
    const pane = page.getByRole('form', { name: 'Commit…' });
    await expect(pane).toBeVisible();
    await expect(pane).toMatchAriaSnapshot({ name: 'commit-pane.aria.yml' });
    await page.getByRole('combobox', { name: 'Commit' }).fill('HEAD~1');
    await page.keyboard.press('Enter');
    const header = page.locator('header');
    await expect(header).toContainText('chore: regenerate the client, refresh the lockfile and the logo');
    await expect(page.getByTitle(/Change what is compared/)).toHaveText(/\^!/);
  });
});
