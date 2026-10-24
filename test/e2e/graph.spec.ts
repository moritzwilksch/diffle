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

  test("Peek lists a node's links in the references overlay; Esc returns to the graph, Enter leaves it", async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await page.keyboard.press('M');
    const graph = page.getByRole('img', { name: 'Change graph' });
    await expect(graph.locator('[data-node]').first()).toBeVisible({ timeout: 15000 });
    const view = page.getByRole('region', { name: 'Change graph view' });
    await page.keyboard.press('j');
    const selected = await graph.locator('[data-node][data-selected]').getAttribute('data-node');

    // The entries the panel lists, each line with its text, grouped under the symbol at the other end.
    await page.getByRole('complementary').last().getByRole('button', { name: 'Peek' }).first().click();
    const list = page.getByRole('dialog', { name: 'References' });
    await expect(list).toBeVisible();
    await expect(list).toMatchAriaSnapshot({ name: 'graph-peek.aria.yml' });
    await expect(page).toHaveScreenshot('graph-peek.png');
    await page.keyboard.press('Space');
    await expect(list.getByRole('region', { name: 'Peek' })).toBeVisible();

    // Esc leaves the peek, then the list, and the graph stays as it was.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(view).toBeVisible();
    await expect(graph.locator(`[data-node="${selected}"][data-selected]`)).toBeVisible();

    // Enter jumps to the diff; Ctrl+o comes back to the graph.
    await page.getByRole('complementary').last().getByRole('button', { name: 'Peek' }).first().click();
    await page.keyboard.press('Enter');
    await expect(view).toBeHidden();
    await page.keyboard.press('Control+o');
    await expect(view).toBeVisible();
  });

  test('Ctrl+o back from a picked link lights only the node it returns to', async ({ page, diffle }) => {
    await waitForLsp(diffle.url);
    await page.keyboard.press('M');
    const graph = page.getByRole('img', { name: 'Change graph' });
    await expect(graph.locator('[data-node]').first()).toBeVisible({ timeout: 15000 });
    await page.keyboard.press('j');
    const selected = await graph.locator('[data-node][data-selected]').getAttribute('data-node');

    // The pick leaves the pointer over the new node's panel, where a card links back to the first.
    const panel = page.getByRole('complementary').last();
    await panel.getByRole('listitem').first().click();
    await expect(graph.locator('[data-node][data-selected]')).not.toHaveAttribute('data-node', selected!);
    const back = panel.getByRole('listitem').first();
    const box = (await back.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(graph.locator('[data-focus="hinted"]')).not.toHaveCount(0);

    await page.keyboard.press('Control+o');
    await expect(graph.locator(`[data-node="${selected}"][data-selected]`)).toBeVisible();
    await expect(graph.locator('[data-focus="hinted"]')).toHaveCount(0);
  });
});
