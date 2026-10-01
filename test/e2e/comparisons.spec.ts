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

test.describe("the range's commits", () => {
  test('lists them, expands one and picks it in the compare menu', async ({ page }) => {
    const box = page.getByRole('region', { name: 'Commits' });
    await expect(box).toMatchAriaSnapshot({ name: 'range-commits.aria.yml' });
    const row = box.getByRole('button', { name: 'refactor: move money helpers into a currency module' });
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(box.getByRole('listitem').nth(1)).toContainText('Grace Hopper');
    // The last commit has a body; hovering it highlights the whole expanded item.
    const last = box.getByRole('listitem').last();
    await last.getByRole('button', { name: /^fix\(cli\)/ }).click();
    await expect(last).toContainText('hid a wrong glob in cron jobs.');
    await last.getByText('Grace Hopper').hover();
    await expect(box).toHaveScreenshot('range-commits.png');
    await box.getByRole('button', { name: 'Pick commit 640d216 in the compare menu' }).click();
    const pane = page.getByRole('form', { name: 'Commit…' });
    await expect(pane.getByRole('combobox', { name: 'Commit' })).toHaveValue('640d216');
    await expect(pane.getByRole('combobox', { name: 'Commit' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('header')).toContainText('refactor: move money helpers into a currency module');
    await expect(box.getByRole('listitem')).toHaveCount(1);
  });

  test('collapses to its header', async ({ page }) => {
    const box = page.getByRole('region', { name: 'Commits' });
    const header = box.getByRole('button', { name: /^Commits/ });
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(box.getByRole('list')).toHaveCount(0);
  });
});

test.describe('a long range of commits', () => {
  test.use({ revs: ['HEAD~7..HEAD'], viewport: { width: 1440, height: 520 } });

  test('starts collapsed and, opened, scrolls within its share of the panel', async ({ page }) => {
    const box = page.getByRole('region', { name: 'Commits' });
    const header = box.getByRole('button', { name: /^Commits/ });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.click();
    await expect(box.getByRole('listitem')).toHaveCount(7);
    const [panel, own] = await Promise.all([page.locator('aside').last().boundingBox(), box.boundingBox()]);
    expect(own!.height).toBeLessThanOrEqual(panel!.height * 0.4 + 1);
    const list = box.getByRole('list').locator('..');
    expect(await list.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    await expect(page).toHaveScreenshot('long-range.png');
  });
});
