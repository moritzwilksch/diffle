import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures.js';
import { activePath } from './browser.js';
import { pushTour, readPrompt, readThreads, REPO_ROOT, seedReply, seedThreads, waitForLsp } from './server.js';
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
<h2>Finding unmatched refunds</h2>
<p>The check reads the ledger twice: once for sales, once for refunds.</p>
<diffle-walk path="tally/refunds.py" lines="12-22">
<diffle-note lines="14" title="One set per account">A missing account starts with an empty set.</diffle-note>
<diffle-note lines="15-17" title="Record each sale">Every sale adds its <code>description</code> to its account's set.</diffle-note>
<diffle-note lines="18-22" title="Keep the unmatched refunds">A refund stays when its account never sold that description.</diffle-note>
</diffle-walk>
<p>The same check, as data moves through it:</p>
<diffle-diagram><svg viewBox="0 0 432 52">
  <g step="1"><rect x="8" y="12" width="104" height="28"/><text x="16" y="26">Ledger entries</text></g>
  <g step="2"><path d="M112 26 H144" class="arrow"/><rect x="144" y="12" width="120" height="28"/><text x="152" y="26">Sales by account</text></g>
  <g step="3"><path d="M264 26 H296" class="arrow"/><rect x="296" y="12" width="128" height="28"/><text x="304" y="26">Unmatched refunds</text></g>
</svg>
<diffle-note title="Read every entry">The check reads the ledger's entries twice.</diffle-note>
<diffle-note title="Collect the sales">Each account's sold descriptions go into one set.</diffle-note>
<diffle-note title="Flag the refunds">A refund whose description is not in its account's set is flagged.</diffle-note>
</diffle-diagram>
<p>Before the check runs, the CLI reads each ledger:</p>
<diffle-trace>
<diffle-stop path="tally/cli.py" line="25">The CLI merges one ledger per file it is given.</diffle-stop>
<diffle-stop path="tally/ledger.py" line="95">Reading a file parses each CSV row into an entry.</diffle-stop>
<diffle-stop path="tally/ledger.py" line="77">A row without a <code>kind</code> counts as a sale.</diffle-stop>
</diffle-trace>
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

/** Two walks, both in view on a laptop's screen. */
const TWO_WALKS = `
<h2>Refunds, in two parts</h2>
<diffle-walk path="tally/refunds.py" lines="14-17">
<diffle-note lines="14" title="One set per account">A missing account starts with an empty set.</diffle-note>
<diffle-note lines="15-17" title="Record each sale">Every sale adds its description.</diffle-note>
</diffle-walk>
<diffle-walk path="tally/refunds.py" lines="18-22">
<diffle-note lines="18-22" title="Keep the unmatched refunds">A refund stays when no sale matches it.</diffle-note>
</diffle-walk>
${'<p>Room to scroll the lower walk to the top.</p>'.repeat(30)}
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
    // The comment panel under the contents says how a comment starts in the tour.
    await expect(page.getByText('Select words and press c to comment on them.')).toBeVisible();
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

  test('a walk lights one note at a time: l / h, its numbers and its gutter markers step through it; a note takes a comment', async ({
    page,
    diffle,
  }) => {
    await pushTour(diffle.url, TOUR);
    const view = await showTour(page);
    const walk = view.locator('figure[data-walk]');
    await page
      .getByRole('navigation', { name: 'Contents' })
      .getByRole('button', { name: /Finding unmatched/ })
      .click();
    await expect(view.getByText('Section 4 of 4')).toBeVisible();
    const note = walk.locator('.tour-note');
    // At rest the diff shows plainly, each note's number on the gutter of its first line.
    await expect(note).toHaveCount(0);
    await expect(walk).toHaveScreenshot('tour-walk.png');

    // l takes the walk's first note, then its second: its lines lit, its text under them.
    await page.keyboard.press('l');
    await page.keyboard.press('l');
    await expect(walk.getByRole('button', { name: /^Note 2/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(note).toContainText('Record each sale');
    await expect(walk).toHaveScreenshot('tour-walk-note.png');

    // A number in the header or on the gutter takes its note; h steps back, past the first to rest.
    await walk.getByRole('button', { name: /^Note 3/ }).click();
    await expect(note).toContainText('Keep the unmatched refunds');
    await walk.locator('[data-mark="1"]').click();
    await expect(note).toContainText('One set per account');
    await page.keyboard.press('h');
    await expect(note).toHaveCount(0);

    // The stepper's controls stay where they are on every step: predictable places to click.
    const controls = walk.getByRole('group', { name: 'Notes' }).getByRole('button');
    // Measured from the walk's corner: a step may scroll the page.
    const boxes = () =>
      controls.evaluateAll((els) =>
        els.map((el) => {
          const [box, walk] = [el.getBoundingClientRect(), el.closest('figure')!.getBoundingClientRect()];
          return [box.left - walk.left, box.top - walk.top, box.width, box.height];
        }),
      );
    const atRest = await boxes();
    expect(atRest).toHaveLength(5);
    for (const n of [1, 2, 3]) {
      await walk.getByRole('button', { name: new RegExp(`^Note ${n}`) }).click();
      await expect(note).toHaveCount(1);
      expect(await boxes()).toEqual(atRest);
    }
    await walk.getByRole('button', { name: /^Note 3/ }).click();
    await expect(note).toHaveCount(0);

    // A note's words take a comment like prose.
    await page.keyboard.press('l');
    await select(page, 'starts with an empty set');
    await page.keyboard.press('c');
    await expect(view.getByPlaceholder('Leave a comment…')).toBeFocused();
    await page.keyboard.type('Why a set?');
    await page.keyboard.press('Control+Enter');
    await expect(view.getByText('Why a set?')).toBeVisible();
    expect(await readPrompt(diffle.url)).toContain(
      '(tour) 4. Finding unmatched refunds, in the note "One set per account" in the walk of tally/refunds.py:12-22\n\n> starts with an empty set',
    );
  });

  test('a stepped diagram lights one step at a time, its note under the drawing', async ({ page, diffle }) => {
    await pushTour(diffle.url, TOUR);
    const view = await showTour(page);
    await page
      .getByRole('navigation', { name: 'Contents' })
      .getByRole('button', { name: /Finding unmatched/ })
      .click();
    const diagram = view.locator('figure[data-stepped]');
    const note = diagram.locator('.tour-note');
    await diagram.scrollIntoViewIfNeeded();
    await expect(note).toHaveCount(0);
    await expect(diagram).toHaveScreenshot('tour-diagram-steps.png');

    await diagram.getByRole('button', { name: /^Step 2/ }).click();
    await expect(note).toContainText('Collect the sales');
    await expect(diagram.locator('g[data-lit]')).toHaveCount(1);
    await page.mouse.move(0, 0);
    await expect(diagram).toHaveScreenshot('tour-diagram-step.png');

    // The taken number again returns the drawing to rest.
    await diagram.getByRole('button', { name: /^Step 2/ }).click();
    await expect(note).toHaveCount(0);
    await expect(diagram.locator('svg[data-stepping]')).toHaveCount(0);
  });

  test('a trace shows one stop at a time: its tabs, its numbers and its line lit among its neighbours', async ({
    page,
    diffle,
  }) => {
    await pushTour(diffle.url, TOUR);
    const view = await showTour(page);
    await page
      .getByRole('navigation', { name: 'Contents' })
      .getByRole('button', { name: /Finding unmatched/ })
      .click();
    const trace = view.locator('figure[data-trace]');
    const note = trace.locator('.tour-note');
    await trace.scrollIntoViewIfNeeded();
    // It starts on its first stop.
    await expect(note).toContainText('merges one ledger per file');
    await expect(trace.getByRole('button', { name: /^Stop 1/ })).toHaveAttribute('aria-pressed', 'true');

    await trace.getByRole('button', { name: 'ledger.py' }).first().click();
    await expect(note).toContainText('parses each CSV row');
    await expect(trace.locator('figcaption')).toContainText('95');
    await page.mouse.move(0, 0);
    await expect(trace).toHaveScreenshot('tour-trace.png');
    await trace.getByRole('button', { name: /^Stop 3/ }).click();
    await expect(note).toContainText('counts as a sale');
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

  test('l and h step one block: the topmost wholly in view, marked so', async ({ page, diffle }) => {
    await pushTour(diffle.url, TWO_WALKS);
    const view = await showTour(page);
    const [upper, lower] = [view.locator('figure[data-walk]').first(), view.locator('figure[data-walk]').last()];
    const stepper = (walk: typeof upper) => walk.getByRole('group', { name: 'Notes' });
    await expect(stepper(upper)).toHaveAttribute('data-targeted');
    await expect(stepper(lower)).not.toHaveAttribute('data-targeted');

    await page.keyboard.press('l');
    await expect(upper.locator('.tour-note')).toContainText('One set per account');
    await expect(lower.locator('.tour-note')).toHaveCount(0);

    // Scrolled past the upper walk, the lower one takes the keys.
    await page.keyboard.press('h');
    await lower.evaluate((el) => {
      const page = el.closest('.overflow-auto')!;
      page.scrollTop += el.getBoundingClientRect().top - page.getBoundingClientRect().top - 8;
    });
    await expect(stepper(lower)).toHaveAttribute('data-targeted');
    await page.keyboard.press('l');
    await expect(lower.locator('.tour-note')).toContainText('Keep the unmatched refunds');
    await expect(upper.locator('.tour-note')).toHaveCount(0);
  });

  test.describe('in a wide window', () => {
    test.use({ viewport: { width: 1680, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });

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

      // yy copies every comment, the code's and the tour's, as in the diff.
      await seedThreads(diffle.url, [{ path: 'tally/ledger.py', startLine: 30, body: 'Why a blank line?' }]);
      await expect(page.getByRole('navigation', { name: 'Contents' })).toBeVisible();
      await page.keyboard.press('y');
      await page.keyboard.press('y');
      await expect(page.getByText('Copied all comments')).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(await readPrompt(diffle.url));
      expect(copied).toContain('tally/ledger.py:30');
      expect(copied).toContain('(tour) 1. Entries learn their kind, in a <p>');

      // The tour's side panel lists every thread under the contents, as the diff's does.
      const side = page.getByRole('complementary').filter({ hasText: 'Negative in which total?' });
      await expect(side).toContainText('Why a blank line?');
      await expect(page.getByText('Copied all comments')).toBeHidden();
      await expect(page).toHaveScreenshot('tour-side.png');
      await side.getByText('Negative in which total?').click();
      await expect(margin.locator('.tour-margin-card[data-active]')).toContainText('Negative in which total?');
      await side.getByText('Why a blank line?').click();
      await expect(view).toBeHidden();
      await expect.poll(() => activePath(page)).toBe('tally/ledger.py');
      await page.keyboard.press('T');
      await expect(view).toBeVisible();

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

  test.describe("in a wide window, a block's Comment button", () => {
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

    test("a deep block's Comment button opens the composer level with it, without moving the page", async ({
      page,
      diffle,
    }) => {
      const filler = Array.from(
        { length: 6 },
        (_, i) => `<h2>Step ${i + 1}</h2><p>${'Context the reader needs first. '.repeat(30)}</p>`,
      ).join('');
      await pushTour(
        diffle.url,
        `${filler}<h2>Parsing</h2>${BLOCKS}`.replace('<h2>Parsing reads the kind column</h2>', ''),
      );
      const view = await showTour(page);
      const card = view.locator('[data-card="parse"]');
      await card.scrollIntoViewIfNeeded();
      const scroller = view.locator('.tour-layout').locator('..');
      const before = await scroller.evaluate((el) => el.scrollTop);
      expect(before).toBeGreaterThan(500);
      await card.locator('p').hover();
      await view.getByRole('button', { name: 'Comment', exact: true }).click();

      const composer = view.getByPlaceholder('Leave a comment…');
      await expect(composer).toBeFocused();
      await expect(composer).toBeInViewport();
      const top = async (el: typeof card) => (await el.boundingBox())!.y;
      expect(Math.abs((await top(view.locator('.tour-margin-card'))) - (await top(card)))).toBeLessThanOrEqual(1);
      expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(1);
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
