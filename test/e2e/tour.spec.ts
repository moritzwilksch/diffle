import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures.js';
import { activePath } from './browser.js';
import { pushTour, REPO_ROOT, waitForLsp } from './server.js';
import type { Page } from '@playwright/test';

const TOUR = `
<h1>Refunds count against sales</h1>
<p>Entries learn a kind, parsing reads it, and refunds that match no sale are reported.</p>
<h2>Entries learn their kind</h2>
<p>An <code>Entry</code> is a sale unless its <code>kind</code> says <strong>refund</strong>; a refund counts negative.</p>
<diffle-diff path="tally/ledger.py" lines="29-34"></diffle-diff>
<h2>Parsing reads the kind column</h2>
<diffle-card id="parse" title="A row defaults to a sale" icon="file-input">
  <p>Any other kind is refused.</p>
  <diffle-diff path="tally/ledger.py" lines="76-79"></diffle-diff>
</diffle-card>
<diffle-callout kind="warning"><p>An unknown kind now fails the whole file.</p></diffle-callout>
<h2>Unmatched refunds</h2>
<p>Refunds of something the account never sold.</p>
<diffle-callout kind="danger"><p>A refund with no matching sale used to count as income.</p></diffle-callout>
<diffle-diff path="tally/refunds.py" lines="12-22"></diffle-diff>
<p>It takes the ledger and hands back entries:</p>
<diffle-row>
<diffle-code path="tally/refunds.py" line="12">def unmatched_refunds(ledger: Ledger) -&gt; list[Entry]: ...</diffle-code>
<diffle-code lang="python">
class Ledger:
    entries: list[Entry]
</diffle-code>
</diffle-row>
<diffle-diagram><svg viewBox="0 0 296 60">
  <rect x="8" y="8" width="280" height="44"/>
  <text x="16" y="22" class="code" lang="python"><tspan x="16" dy="0">def unmatched_refunds(</tspan><tspan x="16" dy="16">    ledger: Ledger) -&gt; list[Entry]</tspan></text>
</svg></diffle-diagram>
<h3><diffle-icon name="folder-tree"></diffle-icon> Where it lives</h3>
<diffle-tree title="Ledger and refunds · Python" icon="package" root="tally" paths="tally/ledger.py
tally/refunds.py
tally/currency.py"><diffle-file path="tally/refunds.py">start here: <diffle-symbol path="tally/refunds.py" line="12" name="unmatched_refunds"></diffle-symbol></diffle-file></diffle-tree>
<p>The CLI now <diffle-jump path="tally/cli.py" line="26">stops on an empty ledger</diffle-jump>.</p>
<table>
  <thead><tr><th>Kind</th><th>Counts as</th></tr></thead>
  <tbody><tr><td><diffle-icon name="circle-plus" tone="success"></diffle-icon> sale</td><td>its amount</td></tr>
  <tr><td><diffle-icon name="circle-minus" tone="error"></diffle-icon> refund</td><td>minus its amount</td></tr>
  <tr><td colspan="2">anything else fails the file</td></tr></tbody>
</table>
<p>Each row parses to an entry; a refund carries its kind:</p>
<diffle-code lang="json" example title="An entry, parsed">
{ "account": "acme", "description": "gadget", "amount": "80.00", "kind": "refund" }
</diffle-code>
<diffle-row>
<div><p>The CLI reads the ledger, and the ledger feeds the new refund check.</p>
<p>Only the refund check is new.</p></div>
<diffle-diagram><svg viewBox="0 0 336 52">
  <g><rect x="8" y="16" width="80" height="28"/><svg data-lucide="terminal" x="16" y="23"/><text x="36" y="30">CLI</text></g>
  <path d="M88 30 H128" class="arrow"/>
  <text x="108" y="20" class="c small">reads</text>
  <g><rect x="128" y="16" width="80" height="28"/><svg data-lucide="book-open" x="136" y="23"/><text x="156" y="30">Ledger</text></g>
  <path d="M208 30 H248" class="arrow"/>
  <text x="228" y="20" class="c small">feeds</text>
  <g class="accent"><rect x="248" y="16" width="80" height="28"/><svg data-lucide="undo-2" x="256" y="23"/><text x="276" y="30">Refunds</text></g>
</svg></diffle-diagram>
</diffle-row>
<h2>Finding unmatched refunds</h2>
<p>The check reads the ledger twice: once for sales, once for refunds.</p>
<p>The check could have read the ledger once:</p>
<diffle-tabs>
<diffle-tab title="Two passes" kind="chosen"><p>Sales first, then refunds, so a refund listed before its sale still matches.</p>
<diffle-diff path="tally/refunds.py" lines="18-22"></diffle-diff></diffle-tab>
<diffle-tab title="One pass" kind="rejected"><p>One pass flags a refund whose sale comes later in the file.</p></diffle-tab>
<diffle-tab title="A flagged refund" kind="example"><diffle-code lang="json" example>{ "account": "acme", "description": "gadget", "kind": "refund" }</diffle-code></diffle-tab>
</diffle-tabs>
<details><summary>Refunds in another currency</summary>
<p>A refund matches a sale by account and description alone; the currency plays no part.</p>
<diffle-diff path="tally/refunds.py" lines="21"></diffle-diff>
</details>
`;

/** The tour view once every card's lines rendered. */
async function showTour(page: Page) {
  const view = page.getByRole('region', { name: 'Tour view' });
  // The push reaches the page over its socket; until then T says there is no tour.
  await expect(async () => {
    if (!(await view.isVisible())) await page.keyboard.press('T');
    await expect(view).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(view.getByText('Loading…')).toHaveCount(0);
  // The icon map loads on a tour's first icon; until then an icon's place is empty.
  await expect(view.locator('.tour-icon:not(:has(svg))')).toHaveCount(0);
  return view;
}

test.describe('the tour', () => {
  test('T shows a pushed tour; n / p walk its sections, a jump opens the diff and Ctrl+o returns', async ({
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
    await expect(view.locator('.tour-diagram-icon')).toHaveCount(3);
    await expect(page).toHaveScreenshot('tour.png');
    const contents = page.getByRole('navigation', { name: 'Contents' });
    await expect(contents).toMatchAriaSnapshot({
      name: 'tour-contents.aria.yml',
    });

    // n takes the first section and scrolls its heading near the top; p does not go before it.
    await page.keyboard.press('n');
    await page.keyboard.press('n');
    await expect(view.getByText('Section 2 of 4')).toBeVisible();
    await expect(contents.getByRole('button', { name: /Parsing reads/ })).toHaveAttribute('aria-current', 'step');
    await expect(page).toHaveScreenshot('tour-step.png');
    await page.keyboard.press('p');
    await page.keyboard.press('p');
    await expect(view.getByText('Section 1 of 4')).toBeVisible();
    await contents.getByRole('button', { name: /Unmatched refunds/ }).click();
    await expect(view.getByText('Section 3 of 4')).toBeVisible();
    await expect(view.locator('aside[aria-label="danger"]')).toHaveScreenshot('tour-danger.png');
    await expect(view.locator('table')).toHaveScreenshot('tour-table.png');
    await expect(view.locator('.tour-block').filter({ hasText: 'Ledger and refunds · Python' })).toHaveScreenshot(
      'tour-tree.png',
    );
    await expect(view.locator('figure').filter({ hasText: 'Example' })).toHaveScreenshot('tour-example.png');
    await expect(view.locator('.tour-row').filter({ has: page.locator('.tour-diagram') })).toHaveScreenshot(
      'tour-row.png',
    );
    await expect(view.locator('.tour-row').filter({ has: page.locator('pre') })).toHaveScreenshot('tour-code.png');
    await expect(view.locator('.tour-diagram').filter({ has: page.locator('text.code') })).toHaveScreenshot(
      'tour-diagram-code.png',
    );

    // A jump leaves for the diff at its line; Ctrl+o comes back to the step it left.
    await page.getByRole('button', { name: 'stops on an empty ledger' }).click();
    await expect(view).toBeHidden();
    await expect.poll(() => activePath(page)).toBe('tally/cli.py');
    await page.keyboard.press('Control+o');
    await expect(view).toBeVisible();
    await expect(view.getByText('Section 3 of 4')).toBeVisible();
  });

  test('an icon draws by its name, an alias as its icon; a name Lucide lacks shows a placeholder naming it', async ({
    page,
    diffle,
  }) => {
    await pushTour(
      diffle.url,
      `<h2>Icons</h2>
<p><diffle-icon name="database"></diffle-icon> stores, <diffle-icon name="databse"></diffle-icon> was misspelt.</p>
<p><diffle-icon name="home"></diffle-icon> is an old name for <diffle-icon name="house"></diffle-icon>.</p>
<diffle-diagram><svg viewBox="0 0 120 44">
  <g><rect x="8" y="8" width="104" height="28"/><svg data-lucide="no-such-icon" x="16" y="15"/><text x="36" y="22">Store</text></g>
</svg></diffle-diagram>`,
    );
    const view = await showTour(page);
    const unknown = view.locator('svg:has(> title)');
    await expect(unknown.locator('title')).toHaveText(['Unknown icon "databse"', 'Unknown icon "no-such-icon"']);
    await expect(view.locator('article p').first()).toHaveScreenshot('tour-icon-unknown.png');
    // An alias Lucide keeps for a renamed icon draws that icon.
    const aliased = view.locator('article p').nth(1).locator('svg');
    const house = await aliased.evaluateAll((svgs) => svgs.map((svg) => svg.outerHTML));
    expect(house).toHaveLength(2);
    expect(house[0]).toBe(house[1]);
  });

  test('tabs show one pane at a time, each titled and marked with what it is', async ({ page, diffle }) => {
    await pushTour(diffle.url, TOUR);
    const view = await showTour(page);
    await page
      .getByRole('navigation', { name: 'Contents' })
      .getByRole('button', { name: /Finding unmatched/ })
      .click();
    const tabs = view.locator('.tour-tabs');
    await tabs.scrollIntoViewIfNeeded();
    await expect(tabs.getByRole('tabpanel')).toContainText('Sales first, then refunds');
    await expect(tabs.getByText('Loading…')).toHaveCount(0);
    await expect(tabs).toHaveScreenshot('tour-tabs.png');

    await tabs.getByRole('tab', { name: /One pass/ }).click();
    await expect(tabs.getByRole('tab', { name: /One pass/ })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.getByRole('tabpanel')).toContainText('flags a refund whose sale comes later');
    await expect(tabs.getByRole('tabpanel')).not.toContainText('Sales first');
  });

  test('details fold away what the main path can do without', async ({ page, diffle }) => {
    await pushTour(diffle.url, TOUR);
    const view = await showTour(page);
    const details = view.locator('details');
    await details.scrollIntoViewIfNeeded();
    await expect(details.getByText('the currency plays no part')).toBeHidden();
    await expect(details).toHaveScreenshot('tour-details.png');
    await details.getByText('Refunds in another currency').click();
    await expect(details.getByText('the currency plays no part')).toBeVisible();
    await expect(details.getByText('Loading…')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(details).toHaveScreenshot('tour-details-open.png');
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
        `<h2>Refunds come out sorted</h2>
        <diffle-diff path="tally/refunds.py" lines="18-25"></diffle-diff>
        <h2>Net per account</h2>
        <diffle-card id="net" title="Net is sales minus refunds">
          <p>Each account nets its refunds against its sales.</p>
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
      await expect(stale.getByText('are no longer in the review')).toBeVisible({
        timeout: 15000,
      });
      await expect(view.getByText('1 stale diff')).toBeVisible();
      const contents = page.getByRole('navigation', { name: 'Contents' });
      await expect(contents.getByRole('button', { name: /Net per account/ })).toContainText('stale');
      await expect(contents.getByRole('button', { name: /Refunds come out sorted/ })).not.toContainText('stale');
      await expect(stale).toHaveScreenshot('tour-stale-card.png');

      // A push replaces the tour in place; the contents follow.
      await pushTour(diffle.url, '<h2>A fresh tour</h2><p>Revised.</p>');
      await expect(contents.getByRole('button')).toHaveText(['1A fresh tour']);
      await expect(view.getByText('1 stale diff')).toBeHidden();
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

    test('a symbol chip is coloured as in the diff, hovers, and lists its references; on the old side it only shows', async ({
      page,
      diffle,
    }) => {
      await waitForLsp(diffle.url);
      await pushTour(
        diffle.url,
        `<h2>Parsing reads the kind</h2>
        <p><diffle-symbol path="tally/ledger.py" line="75" name="parse_row"></diffle-symbol> turns a row into an
        <diffle-symbol path="tally/ledger.py" line="15" name="Entry" side="old"></diffle-symbol>.</p>`,
      );
      const view = await showTour(page);
      await expect(view.locator('code[title^="References are asked of the new side"]')).toHaveText('Entry');
      // Both chips take the colours the highlighter gives them on their lines.
      await expect(view.locator('article p')).toHaveScreenshot('tour-symbols.png');

      // Hovering the chip with a server shows the diff's hover card.
      await view.getByRole('button', { name: 'parse_row' }).hover();
      await expect(page.locator('.hover-markdown')).toContainText('def f() -> None');
      await expect(page).toHaveScreenshot('tour-symbol-hover.png');
      await view.getByRole('button', { name: 'parse_row' }).click();
      const list = page.getByRole('dialog', { name: 'References' });
      await expect(list).toBeVisible();
      await expect(list).toMatchAriaSnapshot({
        name: 'tour-references.aria.yml',
      });

      // Esc returns to the tour; Enter jumps to the diff, and Ctrl+o comes back.
      await page.keyboard.press('Escape');
      await expect(list).toBeHidden();
      await expect(view).toBeVisible();
      // The list opens once its request answers; Enter before that would reach nothing, and the open
      // list would hide the tour from role queries, so the jump is checked where it lands.
      await view.getByRole('button', { name: 'parse_row' }).click();
      await expect(list).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(list).toBeHidden();
      await expect.poll(() => activePath(page)).toBe('tally/ledger.py');
      await expect(view).toBeHidden();
      await page.keyboard.press('Control+o');
      await expect(view).toBeVisible();
    });
  });
});
