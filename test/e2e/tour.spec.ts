import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures.js';
import { activePath } from './browser.js';
import { pushTour, REPO_ROOT, waitForLsp } from './server.js';
import type { Page } from '@playwright/test';

const TOUR = `
<diffle-card id="kind" step="1" title="Entries learn their kind">
  <p>An <code>Entry</code> is a sale unless its <code>kind</code> says <strong>refund</strong>; a refund counts negative.</p>
  <diffle-diff path="tally/ledger.py" lines="29-34"></diffle-diff>
</diffle-card>
<diffle-card id="parse" step="2" title="Parsing reads the kind column">
  <p>A row defaults to a sale and refuses any other kind.</p>
  <diffle-diff path="tally/ledger.py" lines="76-79"></diffle-diff>
  <diffle-callout kind="warning"><p>An unknown kind now fails the whole file.</p></diffle-callout>
</diffle-card>
<diffle-group title="Refunds">
  <diffle-card id="unmatched" step="3" title="Unmatched refunds">
    <p>Refunds of something the account never sold.</p>
    <diffle-diff path="tally/refunds.py" lines="12-22"></diffle-diff>
  </diffle-card>
  <diffle-card id="layout" title="Where it lives">
    <diffle-tree root="tally" paths="tally/ledger.py
tally/refunds.py
tally/currency.py"></diffle-tree>
    <p>The CLI now <diffle-jump path="tally/cli.py" line="26">stops on an empty ledger</diffle-jump>.</p>
  </diffle-card>
</diffle-group>
`;

/** The tour view once every card's lines rendered, fitted to the canvas. */
async function showTour(page: Page) {
  const view = page.getByRole('region', { name: 'Tour view' });
  // The push reaches the page over its socket; until then T says there is no tour.
  await expect(async () => {
    if (!(await view.isVisible())) await page.keyboard.press('T');
    await expect(view).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(view.getByText('Loading…')).toHaveCount(0);
  await page.keyboard.press('0');
  return view;
}

test.describe('the tour', () => {
  test('T shows a pushed tour; n / p walk its steps, a jump opens the diff and Ctrl+o returns', async ({
    page,
    diffle,
  }) => {
    // Without a tour, T says how one comes and stays in the diff.
    await page.keyboard.press('T');
    await expect(page.getByText('No tour yet')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Tour view' })).toBeHidden();

    await expect(page.getByText('No tour yet')).toBeHidden();
    await pushTour(diffle.url, TOUR);
    const view = await showTour(page);
    await expect(page).toHaveScreenshot('tour.png');
    const steps = page.getByRole('navigation', { name: 'Steps' });
    await expect(steps).toMatchAriaSnapshot({ name: 'tour-steps.aria.yml' });

    // n takes the first step and glides to its card; p does not go before it.
    await page.keyboard.press('n');
    await page.keyboard.press('n');
    await expect(view.getByText('Step 2 of 3')).toBeVisible();
    await expect(page.locator('[data-card="parse"]')).toHaveAttribute('aria-current', 'step');
    await expect(page).toHaveScreenshot('tour-step.png');
    await page.keyboard.press('p');
    await page.keyboard.press('p');
    await expect(view.getByText('Step 1 of 3')).toBeVisible();
    await steps.getByRole('button', { name: /Unmatched refunds/ }).click();
    await expect(page.locator('[data-card="unmatched"]')).toHaveAttribute('aria-current', 'step');

    // A jump leaves for the diff at its line; Ctrl+o comes back to the step it left.
    await page.getByRole('button', { name: 'stops on an empty ledger' }).click();
    await expect(view).toBeHidden();
    await expect.poll(() => activePath(page)).toBe('tally/cli.py');
    await page.keyboard.press('Control+o');
    await expect(view).toBeVisible();
    await expect(view.getByText('Step 3 of 3')).toBeVisible();
  });

  test.describe('over the working tree', () => {
    test.use({ revs: ['working'], args: ['--watch'] });

    test('a card whose lines left the review says so in place, and a new push replaces the tour', async ({
      page,
      diffle,
      repo,
    }) => {
      await pushTour(
        diffle.url,
        `<diffle-card id="sorted" step="1" title="Refunds come out sorted">
          <diffle-diff path="tally/refunds.py" lines="18-25"></diffle-diff>
        </diffle-card>
        <diffle-card id="net" step="2" title="Net per account">
          <diffle-diff path="tally/refunds.py" lines="28-30"></diffle-diff>
        </diffle-card>`,
      );
      const view = await showTour(page);
      await expect(view.getByText('stale')).toHaveCount(0);

      // The agent keeps editing: the file shrinks under the second card.
      const file = join(repo, 'tally/refunds.py');
      const lines = (await readFile(file, 'utf8')).split('\n');
      await writeFile(file, lines.slice(0, 26).join('\n'));
      const stale = page.locator('[data-card="net"]');
      await expect(stale.getByText('are no longer in the review')).toBeVisible({ timeout: 15000 });
      await expect(view.getByText('1 stale card')).toBeVisible();
      await expect(page.locator('[data-card="sorted"]').getByText('stale')).toHaveCount(0);
      await expect(stale).toHaveScreenshot('tour-stale-card.png');

      // A push replaces the tour in place; the steps panel follows.
      await pushTour(diffle.url, '<diffle-card id="only" step="1" title="A fresh tour"><p>Revised.</p></diffle-card>');
      await expect(page.getByRole('navigation', { name: 'Steps' }).getByRole('button')).toHaveText(['1A fresh tour']);
      await expect(view.getByText('1 stale card')).toBeHidden();
    });
  });

  test.describe('with a language server', () => {
    // The fake server finds references by whole words, as in the graph's scenarios.
    test.use({
      args: [
        '--lsp',
        `python=${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}`,
      ],
      env: { PATH: '/usr/bin:/bin', FAKE_LSP_GRAPH: '1' },
    });

    test("a symbol chip lists the symbol's references; on the old side it stays plain code", async ({
      page,
      diffle,
    }) => {
      await waitForLsp(diffle.url);
      await pushTour(
        diffle.url,
        `<diffle-card id="parse" step="1" title="Parsing reads the kind">
          <p><diffle-symbol path="tally/ledger.py" line="75" name="parse_row"></diffle-symbol> turns a row into an
          <diffle-symbol path="tally/ledger.py" line="15" name="Entry" side="old"></diffle-symbol>.</p>
        </diffle-card>`,
      );
      const view = await showTour(page);
      await expect(view.locator('code[title^="References are asked of the new side"]')).toHaveText('Entry');
      await view.getByRole('button', { name: 'parse_row' }).click();
      const list = page.getByRole('dialog', { name: 'References' });
      await expect(list).toBeVisible();
      await expect(list).toMatchAriaSnapshot({ name: 'tour-references.aria.yml' });

      // Esc returns to the tour; Enter jumps to the diff, and Ctrl+o comes back.
      await page.keyboard.press('Escape');
      await expect(list).toBeHidden();
      await expect(view).toBeVisible();
      await view.getByRole('button', { name: 'parse_row' }).click();
      await page.keyboard.press('Enter');
      await expect(view).toBeHidden();
      await page.keyboard.press('Control+o');
      await expect(view).toBeVisible();
    });
  });
});
