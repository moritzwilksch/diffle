import { join } from 'node:path';
import { expect, test } from './fixtures.js';
import { gotoFile, hoverSymbol } from './browser.js';
import { REPO_ROOT, waitForLsp } from './server.js';

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
});
