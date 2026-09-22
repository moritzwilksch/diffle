import { expect, test } from './fixtures.js';
import { filePaths, waitForHighlight } from './browser.js';

test.describe('working mode', () => {
  test.use({ revs: ['working'] });

  test('shows the staged, unstaged and untracked changes', async ({ page }) => {
    await expect(page.locator('header')).toContainText('3 files');
    expect(await filePaths(page)).toEqual(['notes/todo.md', 'tally/refunds.py', 'README.md']);
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
