// The Reports view: what a plugin made of the snapshot and what was pushed over the API, beside the
// diff. The fake generator (`test/reports/fake-generator.mjs`) stands in for a plugin: it lists the
// files it was given and renders the fixture's logo as one page per side, so the pages block runs
// through the real runner, blob store, file route and image comparison without Typst.
import { join } from 'node:path';
import { activePath } from './browser.js';
import { expect, test } from './fixtures.js';
import { REPO_ROOT } from './server.js';

const FAKE = join(REPO_ROOT, 'test/reports/fake-generator.mjs');
const ANCHORED = 'tests/test_refunds.py';

/** Pushes a report as an agent would: the JSON straight at the API. */
async function pushReport(url: string, id: string, report: object): Promise<void> {
  const response = await fetch(new URL(`api/reports/${id}`, url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(`pushing ${id} failed: HTTP ${response.status} ${await response.text()}`);
}

test.describe('reports', () => {
  test.use({
    config: {
      plugins: {
        fake: {
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} json`,
          when: ['VERSION'],
          scope: 'tree',
        },
      },
    },
  });

  test('gr shows the generator’s pages and a pushed report; Enter and c leave for the diff at a block’s line', async ({
    page,
    diffle,
  }) => {
    await pushReport(diffle.url, 'notes', {
      title: 'Review notes',
      blocks: [
        {
          kind: 'markdown',
          text: '# Watch the refund path\n\nThe new test only covers the happy path.',
          anchor: { path: ANCHORED, line: 1 },
        },
        { kind: 'markdown', text: 'A general remark, pointing nowhere.' },
      ],
    });
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    const view = page.getByRole('region', { name: 'Reports view' });
    const list = page.getByRole('complementary', { name: 'Reports list' });
    await expect(view).toBeVisible();

    // The generator's report comes first and shows once its run ended: the files it saw, then the pages.
    await expect(view.getByText(/^old: /)).toBeVisible({ timeout: 20000 });
    await expect(view.getByText('Loading image…')).toHaveCount(0);
    await expect(view.getByText('Old · 128 × 96')).toBeVisible();
    await expect(view.getByText('New · 96 × 96')).toBeVisible();
    await expect(list).toMatchAriaSnapshot({ name: 'list.aria.yml' });
    await expect(page).toHaveScreenshot('generator.png');

    // The pushed one lists beside it; its anchored block names its line, the other does not.
    await list.getByRole('button', { name: /Review notes/ }).click();
    await expect(view.getByText('The new test only covers the happy path.')).toBeVisible();
    await expect(view).toMatchAriaSnapshot({ name: 'pushed.aria.yml' });
    await expect(page).toHaveScreenshot('pushed.png');

    // Enter opens the diff at the block's line; gr brings the report back, and c comments on that line.
    await page.keyboard.press('Enter');
    await expect(view).toBeHidden();
    await expect.poll(() => activePath(page)).toBe(ANCHORED);
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(view).toBeVisible();
    await page.keyboard.press('c');
    await expect(view).toBeHidden();
    await expect(page.getByPlaceholder('Leave a comment…')).toBeVisible();
  });
});
