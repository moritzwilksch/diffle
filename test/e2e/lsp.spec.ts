import { chmod, mkdir, writeFile } from 'node:fs/promises';
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

  test('Escape leaves a references peek before it closes the list', async ({ page, diffle }) => {
    const references = await openReferences(page, diffle.url, LINE);
    await page.keyboard.press(' ');
    const peek = page.getByLabel('Peek');
    await expect(peek).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);
    await expect(references).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(references).toHaveCount(0);
  });

  test('regression: a jump from the references list leaves focus on the review', async ({ page, diffle }) => {
    const references = await openReferences(page, diffle.url, LINE);
    await page.keyboard.press('Enter');
    await expect(references).toHaveCount(0);
    // Not a file header's Copy path button, which the next Space would press.
    await expect(page.locator('main[tabindex]')).toBeFocused();
  });

  test.describe('whose definitions point into collapsed context', () => {
    // At 2 context lines, openapi.py folds lines 4–10 between its two hunks; line 20, `refunds=...`, calls in.
    test.use({ env: { PATH: '/usr/bin:/bin', FAKE_LSP_DEFINITION_LINE: '7' } });

    test('regression: go to definition into a diff that cannot hydrate opens the whole file', async ({
      page,
      diffle,
    }) => {
      // Collapsed context expands only in a hydrated diff. Fail openapi.py's old side so its hydration does;
      // the whole file needs only the new side.
      const path = 'tally/generated/openapi.py';
      await page.route(/\/api\/file\?/, async (route) => {
        const params = new URL(route.request().url()).searchParams;
        if (params.get('path') === path && params.get('rev') === 'old') await route.fulfill({ status: 500 });
        else await route.continue();
      });
      // A context change reloads every patch, so the page already open hydrates afresh through the route.
      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = page.getByRole('dialog', { name: 'Settings' });
      await settings.getByRole('spinbutton').fill('2');
      await settings.getByRole('button', { name: 'Save' }).click();
      await expect(settings).toHaveCount(0);
      await gotoFile(page, path);
      await waitForLsp(diffle.url);
      await clickLine(page, path, 20);
      await page.mouse.move(0, 0);
      const line7 = page
        .locator('diffs-container')
        .filter({ has: page.locator(`[slot="header-custom"] [data-path="${path}"]`) })
        .locator('[data-column-number="7"]')
        .last();
      await expect(line7).toHaveCount(0);
      // The first request can land while the bridge is still opening the document; ask again then.
      await expect(async () => {
        await page.keyboard.press('0');
        await page.keyboard.type('gd');
        await expect(line7).toBeInViewport({ timeout: 2000 });
      }).toPass({ timeout: 10000 });
    });
  });
});

// A TypeScript installed in the checkout, and the fake server on PATH as `typescript-language-server`:
// diffle configures it as the real one, so the status names the TypeScript it was pointed at.
const typescriptTest = test.extend({
  repo: async ({ repo }, use) => {
    const typescript = join(repo, 'node_modules', 'typescript');
    await mkdir(join(typescript, 'lib'), { recursive: true });
    await writeFile(join(typescript, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3' }));
    await writeFile(join(typescript, 'lib', 'typescript.js'), '');
    const shim = join(repo, '..', 'bin', 'typescript-language-server');
    await mkdir(join(shim, '..'));
    await writeFile(
      shim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}\n`,
    );
    await chmod(shim, 0o755);
    await use(repo);
  },
  env: async ({ repo }, use) => use({ PATH: `${join(repo, '..', 'bin')}:/usr/bin:/bin` }),
});

typescriptTest.describe('with a TypeScript server', () => {
  typescriptTest.use({ args: ['--lsp', 'typescript=typescript-language-server --stdio'] });

  typescriptTest('the status names the TypeScript the server reads', async ({ page, diffle }) => {
    await waitForLsp(diffle.url);
    await page.getByLabel(/Language servers/).click();
    const status = page.getByRole('region', { name: 'Language server status' });
    await expect(status).toContainText('TypeScript 5.9.3: node_modules/typescript');
    await expect(status).toMatchAriaSnapshot({ name: 'typescript-status.aria.yml' });
    await expect(status).toHaveScreenshot('typescript-status.png');
  });
});

/** Open the references list for the symbol starting `tally/ledger.py`'s line `line`. */
async function openReferences(page: Page, url: string, line: number) {
  await gotoFile(page, 'tally/ledger.py');
  await waitForLsp(url);
  await clickLine(page, 'tally/ledger.py', line);
  await page.mouse.move(0, 0);
  const references = page.getByRole('dialog', { name: 'References' });
  // The first request can land while the bridge is still opening the document; ask again then.
  await expect(async () => {
    await page.keyboard.press('0');
    await page.keyboard.type('gA');
    await expect(references).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 10000 });
  return references;
}
