import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { FEATURE_BRANCH, MAIN_BRANCH } from '../fixture/repo.js';
import { expect, test as base } from './fixtures.js';
import { selectLines } from './browser.js';

const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

/**
 * The fixture with origin at github.com/o/tally: `main` pushed, and the feature branch pushed up
 * to `pushed`. Remote-tracking refs stand for the pushes; nothing is fetched.
 */
const test = base.extend<{ pushed: string }>({
  pushed: [FEATURE_BRANCH, { option: true }],
  repo: async ({ repo, pushed }, use) => {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/o/tally');
    git(repo, 'update-ref', `refs/remotes/origin/${MAIN_BRANCH}`, MAIN_BRANCH);
    git(repo, 'update-ref', `refs/remotes/origin/${FEATURE_BRANCH}`, pushed);
    await use(repo);
  },
});
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const copyLink = (page: Page) => page.getByRole('button', { name: 'Copy link' });

/** Selects lines and waits for the composer to learn whether they have a link. */
async function select(page: Page, path: string, from: number, to: number, side: 'old' | 'new' = 'new') {
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/permalink'));
  await selectLines(page, path, from, to, side);
  await answered;
}

/** Closes the composer, keeping its lines as the cursor, and presses `yl`. */
async function yankLink(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('Leave a comment…')).toHaveCount(0);
  await page.keyboard.press('y');
  await page.keyboard.press('l');
}

test.describe('a pushed branch', () => {
  test('links new lines at the head, removed ones at the merge base under the old name', async ({ page, repo }) => {
    const head = git(repo, 'rev-parse', FEATURE_BRANCH);
    const mergeBase = git(repo, 'merge-base', MAIN_BRANCH, FEATURE_BRANCH);

    await select(page, 'tally/currency.py', 18, 20);
    await copyLink(page).click();
    await expect.poll(() => clipboard(page)).toBe(`https://github.com/o/tally/blob/${head}/tally/currency.py#L18-L20`);

    await page.keyboard.press('Escape');
    // The rename's removed first line lives in tally/money.py at the merge base.
    await select(page, 'tally/currency.py', 1, 1, 'old');
    await copyLink(page).click();
    await expect.poll(() => clipboard(page)).toBe(`https://github.com/o/tally/blob/${mergeBase}/tally/money.py#L1`);
  });

  test('yl copies the link to the cursor lines', async ({ page, repo }) => {
    const head = git(repo, 'rev-parse', FEATURE_BRANCH);
    await select(page, 'tally/currency.py', 7, 7);
    await yankLink(page);
    await expect(page.getByText('Copied GitHub link')).toBeVisible();
    await expect.poll(() => clipboard(page)).toBe(`https://github.com/o/tally/blob/${head}/tally/currency.py#L7`);
  });
});

test.describe('a branch whose head is not pushed', () => {
  test.use({ pushed: `${FEATURE_BRANCH}~1` });

  test('offers no link and says why', async ({ page }) => {
    await select(page, 'tally/currency.py', 7, 7);
    await expect(copyLink(page)).toHaveCount(0);
    await yankLink(page);
    await expect(page.getByText('Not on GitHub: these lines are not in a pushed commit')).toBeVisible();
  });
});

test.describe('working mode', () => {
  test.use({ revs: ['working'] });

  test('offers no link to uncommitted lines', async ({ page }) => {
    await select(page, 'tally/refunds.py', 18, 18);
    await expect(copyLink(page)).toHaveCount(0);
    await yankLink(page);
    await expect(page.getByText('Uncommitted lines have no GitHub link')).toBeVisible();
  });
});
