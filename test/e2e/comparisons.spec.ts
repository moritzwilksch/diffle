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
  test('shows a hovered commit in full', async ({ page }) => {
    const box = page.getByRole('region', { name: 'Commits' });
    await expect(box).toMatchAriaSnapshot({ name: 'range-commits.aria.yml' });
    await box.getByRole('button', { name: /^fix\(cli\)/ }).hover();
    const card = page.getByRole('tooltip');
    await expect(card).toContainText('fix(cli): report an empty ledger instead of crashing');
    await expect(card).toContainText('hid a wrong glob in cron jobs.');
    await expect(card).toContainText('Grace Hopper');
    await expect(page).toHaveScreenshot('commit-card.png');
    await page.mouse.move(0, 0);
    await expect(card).toHaveCount(0);
  });

  test('focuses one commit, steps through the range and returns to all changes', async ({ page }) => {
    const box = page.getByRole('region', { name: 'Commits' });
    const picker = page.getByTitle(/Change what is compared/);
    const header = page.locator('header');
    const all = box.getByRole('button', { name: /^All changes/ });
    await expect(all).toHaveAttribute('aria-current', 'true');
    await expect(box.getByRole('button', { name: 'Previous commit' })).toBeDisabled();

    await box.getByRole('button', { name: /^refactor: move money helpers/ }).click();
    await expect(picker).toHaveText(/main\.\.\.feature\/refunds @ 640d216/);
    await expect(header).toContainText('refactor: move money helpers into a currency module');
    const active = box.locator('[aria-current="true"]');
    await expect(active).toContainText('Grace Hopper');
    await expect(all).not.toHaveAttribute('aria-current');
    // The range still lists all its commits while one is shown.
    await expect(box.getByRole('listitem')).toHaveCount(4);
    await waitForHighlight(page, 'tally/currency.py');
    await expect(page).toHaveScreenshot('focused-commit.png');

    await box.getByRole('button', { name: 'Next commit' }).click();
    await expect(active).toContainText('chore: regenerate the client');
    await page.keyboard.press('<');
    await expect(active).toContainText('refactor: move money helpers');
    await page.keyboard.press('<');
    await expect(active).toContainText('feat(ledger): support refund lines');
    await page.keyboard.press('<');
    await expect(all).toHaveAttribute('aria-current', 'true');
    await expect(picker).toHaveText(/^main\.\.\.feature\/refunds/);
    await expect(header).toContainText('17 files');
  });

  test('collapses to its header', async ({ page }) => {
    const box = page.getByRole('region', { name: 'Commits' });
    const toggle = box.getByRole('button', { name: /^Commits/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
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
