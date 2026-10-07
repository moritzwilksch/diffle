import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { clickLine, gotoFile, hoverSymbol } from './browser.js';
import { REPO_ROOT, waitForLsp } from './server.js';

/** The text under the word focus and under each occurrence tint, as the viewer paints them. */
function highlighted(page: Page) {
  return page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Iterable<AbstractRange>> }).highlights;
    const texts = (name: string) => [...(registry.get(name) ?? [])].map((range) => range.toString());
    return {
      focus: texts('diffle-word-focus'),
      read: texts('diffle-occurrence-read'),
      write: texts('diffle-occurrence-write'),
    };
  });
}

test.describe('with a language server', () => {
  // The fake server from the unit tests: it answers hover with a fixed signature, so the tooltip
  // exercises the real bridge, request and rendering without a Python toolchain.
  test.use({
    args: [
      '--lsp',
      `python=${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}`,
    ],
    // The diff's other languages are resolved on PATH; a bare one keeps a developer's installed
    // servers out of the screenshot.
    env: { PATH: '/usr/bin:/bin' },
  });

  test('shows a hover tooltip for a symbol', async ({ page, diffle }) => {
    await gotoFile(page, 'tally/ledger.py');
    await waitForLsp(diffle.url);
    await expect(page.getByLabel(/Language servers/)).toBeVisible();
    const tooltip = page.getByRole('tooltip');
    // The first hover can land while the bridge is still opening the document; hover again then.
    await expect(async () => {
      await hoverSymbol(page, 'round_amount', { path: 'tally/ledger.py' });
      await expect(tooltip).toContainText('def f() -> None', { timeout: 2000 });
    }).toPass({ timeout: 10000 });
    await expect(tooltip).toHaveScreenshot('hover.png');
  });

  // ledger.py line 33 is `amount = self.unit_price * self.quantity`, in `Entry.total`; the fake server
  // highlights a word wherever it recurs in the enclosing block, the one followed by `=` as a write.
  const LINE = 33;

  test('tints where the keyboard-focused symbol recurs, writes apart from reads', async ({ page, diffle }) => {
    await gotoFile(page, 'tally/ledger.py');
    await waitForLsp(diffle.url);
    await clickLine(page, 'tally/ledger.py', LINE);
    // The pointer must rest on no symbol, or it would win over the keyboard focus.
    await page.mouse.move(0, 0);
    // The first request can land while the bridge is still opening the document; focus again then.
    await expect(async () => {
      await page.keyboard.press('0');
      await expect
        .poll(() => highlighted(page), { timeout: 2000 })
        .toEqual({ focus: ['amount'], read: ['amount', 'amount'], write: ['amount'] });
    }).toPass({ timeout: 10000 });
    await expect(page).toHaveScreenshot('occurrences.png');
    // `w` moves on; held down it repeats, and only the word it settles on is asked about.
    await page.keyboard.press('w');
    await expect.poll(() => highlighted(page)).toEqual({ focus: ['self'], read: [], write: [] });
    await page.keyboard.press('b');
    await expect
      .poll(() => highlighted(page))
      .toEqual({ focus: ['amount'], read: ['amount', 'amount'], write: ['amount'] });
    // The focus belongs to its row: moving the line cursor off it drops the focus and its tint.
    await page.keyboard.press('j');
    await expect.poll(() => highlighted(page)).toEqual({ focus: [], read: [], write: [] });
  });

  test('the resting pointer wins over the keyboard focus and hands back when it leaves', async ({ page, diffle }) => {
    await gotoFile(page, 'tally/ledger.py');
    await waitForLsp(diffle.url);
    await clickLine(page, 'tally/ledger.py', LINE);
    await page.mouse.move(0, 0);
    const quantity = { focus: ['quantity'], read: ['quantity', 'quantity'], write: [] };
    await expect(async () => {
      await page.keyboard.press('$');
      await expect.poll(() => highlighted(page), { timeout: 2000 }).toEqual(quantity);
    }).toPass({ timeout: 10000 });
    await hoverSymbol(page, 'amount', { path: 'tally/ledger.py' });
    await expect
      .poll(() => highlighted(page))
      .toEqual({ focus: ['quantity'], read: ['amount', 'amount'], write: ['amount'] });
    // The tooltip follows the tint, on its own longer delay.
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.mouse.move(0, 0);
    await expect.poll(() => highlighted(page)).toEqual(quantity);
  });

  test('a click opens the symbol popover and focuses the symbol without losing its tint', async ({ page, diffle }) => {
    await gotoFile(page, 'tally/ledger.py');
    await waitForLsp(diffle.url);
    await expect(async () => {
      await hoverSymbol(page, 'amount', { path: 'tally/ledger.py' });
      await expect.poll(() => highlighted(page), { timeout: 2000 }).toMatchObject({ write: ['amount'] });
    }).toPass({ timeout: 10000 });
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByRole('menu')).toBeVisible();
    const amount = { focus: ['amount'], read: ['amount', 'amount'], write: ['amount'] };
    await expect.poll(() => highlighted(page)).toEqual(amount);
    // The click also moved the line cursor onto the symbol's row, which keeps the focus and so the tint
    // once the pointer leaves.
    await page.mouse.move(0, 0);
    await expect.poll(() => highlighted(page)).toEqual(amount);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => highlighted(page)).toEqual({ focus: [], read: [], write: [] });
  });

  test('a word inside a word-level diff mark hovers, clicks and focuses like any other', async ({ page, diffle }) => {
    // ledger.py line 12 adds `Literal` to an import; the mark nests it in spans inside its token.
    await gotoFile(page, 'tally/ledger.py');
    await waitForLsp(diffle.url);
    await expect(async () => {
      await hoverSymbol(page, 'Literal', { path: 'tally/ledger.py' });
      await expect(page.getByRole('tooltip')).toContainText('def f() -> None', { timeout: 2000 });
    }).toPass({ timeout: 10000 });
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect.poll(async () => (await highlighted(page)).focus).toEqual(['Literal']);
  });

  test('a click on a wrapped row targets the word under the pointer, not the one above it', async ({
    page,
    diffle,
  }) => {
    // ledger.py line 3 is a docstring line long enough to wrap; `negative` ends it, on a lower row.
    await gotoFile(page, 'tally/ledger.py');
    await waitForLsp(diffle.url);
    await hoverSymbol(page, 'negative', { path: 'tally/ledger.py' });
    const rows = await page
      .locator('span[data-char]', { hasText: 'count negative' })
      .first()
      .evaluate((token) => new Set([...token.getClientRects()].map((rect) => Math.round(rect.top))).size);
    expect(rows).toBeGreaterThan(1);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(async () => (await highlighted(page)).focus).toEqual(['negative']);
    // A word in a string names no symbol: the syntax gate keeps the popover closed.
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});
