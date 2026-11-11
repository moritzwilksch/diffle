import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures.js';
import { activePath } from './browser.js';
import { pushTour, readPrompt, readThreads, REPO_ROOT, seedReply, waitForLsp } from './server.js';
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
<diffle-tree root="tally" paths="tally/ledger.py
tally/refunds.py
tally/currency.py"></diffle-tree>
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
`;

/** A short tour to comment on. */
const COMMENTED = `
<h1>Refunds count against sales</h1>
<h2>Entries learn their kind</h2>
<p>An <code>Entry</code> is a sale unless its <code>kind</code> says <strong>refund</strong>; a refund counts negative.</p>
<diffle-diff path="tally/ledger.py" lines="29-34"></diffle-diff>
<h2>Parsing reads the kind column</h2>
<p>Any other kind is refused.</p>
`;

/** A card and a diagram to comment on as a whole. */
const BLOCKS = `
<h2>Parsing reads the kind column</h2>
<diffle-card id="parse" title="A row defaults to a sale">
  <p>Any other kind is refused.</p>
  <diffle-diff path="tally/ledger.py" lines="76-79"></diffle-diff>
</diffle-card>
<diffle-diagram><svg viewBox="0 0 216 52">
  <rect x="8" y="16" width="80" height="28"/><text x="48" y="30" class="c">CLI</text>
  <path d="M88 30 H128" class="arrow"/>
  <rect x="128" y="16" width="80" height="28"/><text x="168" y="30" class="c">Ledger</text>
</svg></diffle-diagram>
`;

/** Selects `words` in the tour's article, as a reader dragging across them would. */
async function select(page: Page, words: string) {
  await page.evaluate((words) => {
    const article = document.querySelector('.tour-article')!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(words);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + words.length);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      return;
    }
    throw new Error(`"${words}" is not in the tour`);
  }, words);
}

/** The tour view once every card's lines rendered. */
async function showTour(page: Page) {
  const view = page.getByRole('region', { name: 'Tour view' });
  // The push reaches the page over its socket; until then T says there is no tour.
  await expect(async () => {
    if (!(await view.isVisible())) await page.keyboard.press('T');
    await expect(view).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(view.getByText('Loading…')).toHaveCount(0);
  // Each icon loads its own chunk; until then its place is empty.
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
    await expect(view.getByText('Section 2 of 3')).toBeVisible();
    await expect(contents.getByRole('button', { name: /Parsing reads/ })).toHaveAttribute('aria-current', 'step');
    await expect(page).toHaveScreenshot('tour-step.png');
    await page.keyboard.press('p');
    await page.keyboard.press('p');
    await expect(view.getByText('Section 1 of 3')).toBeVisible();
    await contents.getByRole('button', { name: /Unmatched refunds/ }).click();
    await expect(view.getByText('Section 3 of 3')).toBeVisible();
    await expect(view.locator('aside[aria-label="danger"]')).toHaveScreenshot('tour-danger.png');
    await expect(view.locator('table')).toHaveScreenshot('tour-table.png');
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
    await expect(view.getByText('Section 3 of 3')).toBeVisible();
  });

  test.describe('in a wide window', () => {
    test.use({ viewport: { width: 1680, height: 900 } });

    test('selected words take a comment in the margin; the agent answers, the prompt carries it, and a revision it loses keeps it below', async ({
      page,
      diffle,
    }) => {
      await pushTour(diffle.url, COMMENTED);
      const view = await showTour(page);
      const button = view.getByRole('button', { name: 'Comment', exact: true });
      // A block's button leaves with the pointer, and waits for a pointer on its way to it.
      const diff = view.locator('figure').first();
      await diff.hover();
      await expect(button).toBeVisible();
      await view.getByText('Any other kind is refused.').hover();
      await expect(button).toBeHidden();
      await diff.hover();
      await button.click();
      await expect(view.getByPlaceholder('Leave a comment…')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(view.getByPlaceholder('Leave a comment…')).toBeHidden();

      await select(page, 'a refund counts negative');
      const margin = view.getByLabel('Comments');
      await expect(view.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
      await page.keyboard.press('c');
      await expect(view.getByPlaceholder('Leave a comment…')).toBeFocused();
      await page.keyboard.type('Negative in which total?');
      await page.keyboard.press('Control+Enter');
      const card = margin.locator('.tour-margin-card').filter({ hasText: 'Negative in which total?' });
      await expect(card).toBeVisible();
      await expect(card).toContainText('"a refund counts negative"');

      // The agent answers from its own session; the reply shows on the card, marked as the agent's.
      const [thread] = await readThreads(diffle.url);
      await seedReply(diffle.url, thread!.id, {
        body: 'In the account total.',
        author: 'agent',
      });
      await expect(card).toContainText('In the account total.');
      await page.mouse.click(1, 1);
      await expect(page).toHaveScreenshot('tour-comment.png');
      expect(await readPrompt(diffle.url)).toContain(
        '(tour) 1. Entries learn their kind, in a <p>\n\n> a refund counts negative\n\nNegative in which total?\n\n(agent) In the account total.',
      );

      // The comment panel opens the thread back in the tour.
      await page.keyboard.press('T');
      await page.getByRole('complementary').getByText('Negative in which total?').click();
      await expect(view).toBeVisible();

      // A revision that drops the words keeps the thread, below the tour.
      await pushTour(diffle.url, COMMENTED.replace('a refund counts negative', 'refunds subtract'));
      const lost = view.getByRole('region', {
        name: 'Comments not in this tour',
      });
      await expect(lost).toContainText('Negative in which total?');
      await expect(view.getByText('1 comment not in this tour')).toBeVisible();
      await expect(lost).toHaveScreenshot('tour-comment-lost.png');
      await expect(margin.locator('.tour-margin-card')).toHaveCount(0);
    });
  });

  test.describe('in a wide window, a block with a thread at its top', () => {
    test.use({ viewport: { width: 1680, height: 900 } });

    test("a block's Comment button takes the free margin beside the thread, never covering it", async ({
      page,
      diffle,
    }) => {
      await pushTour(diffle.url, COMMENTED);
      const view = await showTour(page);
      const button = view.getByRole('button', { name: 'Comment', exact: true });
      const diff = view.locator('figure').first();
      await diff.hover();
      await button.click();
      await expect(view.getByPlaceholder('Leave a comment…')).toBeFocused();
      await page.keyboard.type('Which lines count?');
      await page.keyboard.press('Control+Enter');
      const card = view.locator('.tour-margin-card').filter({ hasText: 'Which lines count?' });
      await expect(card).toBeVisible();

      await diff.hover();
      await expect(button).toBeVisible();
      const [b, c] = [(await button.boundingBox())!, (await card.boundingBox())!];
      expect(b.y >= c.y + c.height || b.y + b.height <= c.y).toBe(true);
      await expect(page).toHaveScreenshot('tour-comment-button-clear.png');
    });
  });

  test('a diagram box takes a comment with a click and a card with its button; a narrow page shows them under their blocks', async ({
    page,
    diffle,
  }) => {
    await pushTour(diffle.url, BLOCKS);
    const view = await showTour(page);
    await view.locator('.tour-diagram').getByText('Ledger').click();
    await expect(view.getByPlaceholder('Leave a comment…')).toBeFocused();
    await page.keyboard.type('Does the ledger check this?');
    await page.keyboard.press('Control+Enter');
    await view.locator('[data-card="parse"] p').hover();
    await view.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(view.getByPlaceholder('Leave a comment…')).toBeFocused();
    await page.keyboard.type('Why a sale by default?');
    await page.keyboard.press('Control+Enter');

    const threads = view.locator('.tour-inline-threads');
    await expect(threads).toHaveCount(2);
    await expect(threads.first()).toContainText('card "A row defaults to a sale"');
    await expect(threads.last()).toContainText('box "Ledger"');
    const contents = page.getByRole('navigation', { name: 'Contents' });
    await expect(contents.getByRole('button', { name: /Parsing reads/ })).toContainText('2');
    await page.mouse.move(1, 1);
    await expect(page).toHaveScreenshot('tour-comment-inline.png');
    const prompt = await readPrompt(diffle.url);
    expect(prompt).toContain(
      '(tour) 1. Parsing reads the kind column, on the card #parse\n\n> A row defaults to a sale',
    );
    expect(prompt).toContain('(tour) 1. Parsing reads the kind column, on a box in the diagram\n\n> Ledger');
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
