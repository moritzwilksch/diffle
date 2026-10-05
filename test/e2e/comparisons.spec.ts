import { execFileSync } from 'node:child_process';
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
    await expect(box.getByRole('button', { name: 'Newer commit' })).toBeDisabled();

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

    // Focus follows the shown commit, and a key press after the click draws no ring around it.
    await page.keyboard.press('>');
    await expect(active).toContainText('chore: regenerate the client');
    await expect(active.getByRole('button', { name: /^chore/ })).toBeFocused();
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('none');
    await page.keyboard.press('>');
    await expect(active).toContainText('fix(cli): report an empty ledger');
    await page.keyboard.press('>');
    await expect(all).toHaveAttribute('aria-current', 'true');
    await expect(picker).toHaveText(/^main\.\.\.feature\/refunds/);
    await expect(header).toContainText('17 files');

    // From the range, older steps to the newest commit.
    await box.getByRole('button', { name: 'Older commit' }).click();
    await expect(active).toContainText('fix(cli): report an empty ledger');
  });

  test('copies a full hash and shows a check mark on it', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const box = page.getByRole('region', { name: 'Commits' });
    await box.getByRole('button', { name: 'Copy hash 640d216' }).click();
    await expect(box.getByRole('button', { name: 'Copied 640d216' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^640d216[0-9a-f]{33}$/);
    // Copying does not focus the commit.
    await expect(box.getByRole('button', { name: /^All changes/ })).toHaveAttribute('aria-current', 'true');
    await expect(box).toHaveScreenshot('copied-hash.png');
    await expect(box.getByRole('button', { name: 'Copy hash 640d216' })).toBeVisible();
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

test.describe('moved refs', () => {
  test.use({ args: ['--watch'] });

  test('keeps the review while the compared branch moves, and reloads on request', async ({ page, repo }) => {
    // Three pushes, each reloaded and compared: well over the default budget in the container.
    test.slow();
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        // Fixed identity and dates: the new commit's hash appears in the snapshots.
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_AUTHOR_DATE: '2024-06-01T12:00:00Z',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_COMMITTER_DATE: '2024-06-01T12:00:00Z',
        },
      }).trim();
    const notice = page.locator('header').getByRole('status');
    const box = page.getByRole('region', { name: 'Commits' });
    await expect(notice).toHaveCount(0);
    await expect(box.getByRole('listitem')).toHaveCount(4);

    // A new commit on the branch out of the staged change, without touching the index or the worktree.
    const tip = git('rev-parse', 'feature/refunds');
    const wip = git('commit-tree', '-p', tip, '-m', 'wip: more refunds', git('write-tree'));
    git('update-ref', 'refs/heads/feature/refunds', wip);
    await expect(notice).toContainText(`feature/refunds ${tip.slice(0, 7)} → ${wip.slice(0, 7)}`);
    await expect(box.getByRole('listitem')).toHaveCount(4);
    await expect(page.locator('header')).toHaveScreenshot('moved-refs.png');

    await notice.getByRole('button', { name: 'Reload' }).click();
    await expect(notice).toHaveCount(0);
    await expect(box.getByRole('listitem')).toHaveCount(5);
    await expect(box).toContainText('wip: more refunds');
    await expect(page.locator('header')).toContainText('17 files');

    // Both loaded states are iterations; the older one opens what the branch changed since.
    const iterations = page.getByRole('region', { name: 'Iterations' });
    await expect(iterations.getByRole('listitem')).toHaveCount(2);
    await iterations.getByRole('button', { name: /^#1/ }).click();
    await expect(page.getByTitle(/Change what is compared/)).toHaveText(/main\.\.\.feature\/refunds #1→#2/);
    await expect(page.locator('header')).toContainText('1 file');
    expect(await filePaths(page)).toEqual(['tally/refunds.py']);
    await expect(iterations.locator('[aria-current="true"]')).toContainText('#1');
    await waitForHighlight(page, 'tally/refunds.py');
    // Comments are off here: no file-comment button, and the panel says why.
    await expect(page.getByTitle(/Comment on this file/)).toHaveCount(0);
    await expect(page.locator('aside').last()).toContainText('Comments are off while comparing iterations');
    // The pointer still rests on the clicked row; its tooltip must not be in the picture.
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot('interdiff.png');

    // The commits box pairs the two iterations: four unchanged, the pushed one added; only that one opens.
    await expect(box.getByRole('listitem')).toHaveCount(5);
    await expect(box).toMatchAriaSnapshot({ name: 'range-diff.aria.yml' });
    // Both hashes of a pair, and an iteration's, copy like a commit's.
    await expect(box.getByRole('button', { name: 'Copy hash 1de24f1' })).toHaveCount(2);
    await expect(iterations.getByRole('button', { name: 'Copy hash 1de24f1' })).toHaveCount(1);
    await box.getByRole('button', { name: /^wip: more refunds/ }).click();
    await expect(page.getByTitle(/Change what is compared/)).toHaveText(/#1→#2 @ [0-9a-f]{7}/);
    await expect(page.locator('header')).toContainText('wip: more refunds');
    await expect(box.locator('[aria-current="true"]')).toContainText('added');
    await expect(box.getByRole('button', { name: 'Older commit' })).toBeDisabled();
    await page.keyboard.press('>');
    await expect(page.getByTitle(/Change what is compared/)).toHaveText(/#1→#2\s*$/);

    // "All changes" leads back to the range.
    await box.getByRole('button', { name: /^All changes/ }).click();
    await expect(page.getByTitle(/Change what is compared/)).toHaveText(/^main\.\.\.feature\/refunds\s*$/);
    await expect(page.locator('header')).toContainText('17 files');

    // A third push: the list picks any two. A plain click sets the span's lower number, shift-click its higher.
    const third = git('commit-tree', '-p', wip, '-m', 'wip: and more', `${wip}^{tree}`);
    git('update-ref', 'refs/heads/feature/refunds', third);
    await expect(notice).toBeVisible();
    await page.keyboard.press('r');
    await expect(iterations.getByRole('listitem')).toHaveCount(3);
    const picker = page.getByTitle(/Change what is compared/);
    await iterations.getByRole('button', { name: /^#1/ }).click();
    await expect(picker).toHaveText(/#1→#3/);
    await iterations.getByRole('button', { name: /^#2/ }).click({ modifiers: ['Shift'] });
    await expect(picker).toHaveText(/#1→#2/);
    await expect(iterations).toMatchAriaSnapshot({ name: 'iterations-span.aria.yml' });
    await iterations.getByRole('button', { name: /^#3/ }).click({ modifiers: ['Shift'] });
    await expect(picker).toHaveText(/#1→#3/);
    await iterations.getByRole('button', { name: /^#2/ }).click();
    await expect(picker).toHaveText(/#2→#3/);
    await iterations.getByRole('button', { name: /^#1/ }).click();
    await expect(picker).toHaveText(/#1→#3/);

    // The same from the keyboard: ii toggles, ij / ik and iJ / iK move the ends, i2 picks, r has nothing to reload.
    await page.keyboard.type('ii');
    await expect(picker).toHaveText(/^main\.\.\.feature\/refunds\s*$/);
    await page.keyboard.type('ii');
    await expect(picker).toHaveText(/#2→#3/);
    await page.keyboard.type('ij');
    await expect(picker).toHaveText(/#1→#3/);
    await page.keyboard.type('iJ');
    await expect(picker).toHaveText(/#1→#2/);
    await page.keyboard.type('iK');
    await expect(picker).toHaveText(/#1→#3/);
    await page.keyboard.type('i2');
    await expect(picker).toHaveText(/#2→#3/);
    await page.keyboard.press('r');
    await expect(page.getByText('Nothing moved since this snapshot')).toBeVisible();

    // Forgetting the iterations leaves the range, with its current state as the only one; the list hides.
    // The header's forget-all button precedes each row's own.
    const forget = iterations.getByRole('button', { name: /Forget/ }).first();
    await forget.click();
    await expect(forget).toHaveText('Forget all?');
    await forget.click();
    await expect(picker).toHaveText(/^main\.\.\.feature\/refunds\s*$/);
    await expect(iterations).toHaveCount(0);
    await page.keyboard.type('ii');
    await expect(page.getByText('Only one iteration so far')).toBeVisible();

    // Reloading "Always", a push recomputes the review on its own: no notice, a new iteration.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('radio', { name: 'Always' }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    git(
      'update-ref',
      'refs/heads/feature/refunds',
      git('commit-tree', '-p', third, '-m', 'wip: followed', `${third}^{tree}`),
    );
    await expect(iterations.getByRole('listitem')).toHaveCount(2);
    await expect(notice).toHaveCount(0);
  });
});
