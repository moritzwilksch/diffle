import { join } from 'node:path';
import { expect, test } from './fixtures.js';
import { activePath } from './browser.js';
import { REPO_ROOT, waitForLsp } from './server.js';

test.describe('the change graph', () => {
  // The fake server's graph mode outlines Python by its `class` and `def` lines and finds
  // references by whole words, so the graph runs through the real bridge, route, layout and panel
  // without a Python toolchain. Its hovers are canned, which the panel shows as they come.
  test.use({
    args: [
      '--lsp',
      `python=${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}`,
    ],
    env: { PATH: '/usr/bin:/bin', FAKE_LSP_GRAPH: '1' },
  });

  test('M shows the graph in place of the diff; Enter opens a symbol there and M returns', async ({ page, diffle }) => {
    await waitForLsp(diffle.url);
    await page.keyboard.press('M');
    const graph = page.getByRole('img', { name: 'Change graph' });
    await expect(graph.locator('[data-node]').first()).toBeVisible({ timeout: 15000 });
    const view = page.getByRole('region', { name: 'Change graph view' });
    await expect(page).toHaveScreenshot('graph.png');
    await expect(page.getByRole('complementary').last()).toMatchAriaSnapshot({ name: 'graph-overview.aria.yml' });

    // The keys walk the graph from its first entry point; Enter leaves for the diff at that symbol.
    await page.keyboard.press('j');
    const selected = await graph.locator('[data-node][data-selected]').getAttribute('data-node');
    expect(selected).toBeTruthy();
    await page.keyboard.press('Enter');
    await expect(view).toBeHidden();
    await expect.poll(() => activePath(page)).toBe(selected!.split(':')[0]);

    // M brings the graph back as it was left, the selection with it; Escape clears the selection
    // and stays in the graph, and M leaves it.
    await page.keyboard.press('M');
    await expect(view).toBeVisible();
    await expect(graph.locator(`[data-node="${selected}"][data-selected]`)).toBeVisible();

    // A linked node picked in the details is a jump: Ctrl+o returns to the selection before it, Ctrl+i goes again.
    await page.getByRole('complementary').last().getByRole('listitem').first().click();
    const picked = graph.locator('[data-node][data-selected]');
    await expect(picked).not.toHaveAttribute('data-node', selected!);
    const linked = await picked.getAttribute('data-node');
    await page.keyboard.press('Control+o');
    await expect(picked).toHaveAttribute('data-node', selected!);
    await page.keyboard.press('Control+i');
    await expect(picked).toHaveAttribute('data-node', linked!);

    await page.keyboard.press('Escape');
    await expect(graph.locator('[data-selected]')).toHaveCount(0);
    await expect(view).toBeVisible();
    await page.keyboard.press('M');
    await expect(view).toBeHidden();
  });
});
