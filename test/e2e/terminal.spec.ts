import { expect, test } from './fixtures.js';
import { activePath, gotoFile } from './browser.js';
import type { Page } from '@playwright/test';

test.use({ terminal: true });

function capture(page: Page) {
  const output = new Map<string, string>();
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    const pane = url.searchParams.get('pane');
    if (!pane || !url.pathname.endsWith('/api/terminal/socket')) return;
    socket.on('framereceived', ({ payload }) => {
      output.set(pane, (output.get(pane) ?? '') + payload.toString());
    });
  });
  return output;
}

async function run(page: Page, command: string) {
  await page.evaluate((text) => navigator.clipboard.writeText(text), command);
  await page.keyboard.press('Control+Shift+V');
  await page.keyboard.press('Enter');
}

test('retains independent shells while the bottom panel is hidden', async ({ page, repo }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const output: string[] = [];
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.endsWith('/api/terminal/socket')) return;
    const i = output.push('') - 1;
    socket.on('framereceived', ({ payload }) => {
      output[i] += payload.toString();
    });
  });
  const panel = page.getByRole('region', { name: 'Terminal panel' });
  const run = async (command: string) => {
    await page.evaluate((text) => navigator.clipboard.writeText(text), command);
    await page.keyboard.press('Control+Shift+V');
    await page.keyboard.press('Enter');
  };

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(panel.locator('canvas').first()).toBeVisible();
  await expect.poll(() => output[0]?.length ?? 0).toBeGreaterThan(0);
  await run('printf "<cwd>%s</cwd>\\n" "$PWD"');
  await expect.poll(() => output[0]).toContain(`<cwd>${repo}</cwd>`);
  await run('export DIFFLE_TAB_TEST=first');

  await panel.getByRole('button', { name: 'New terminal' }).click();
  await expect.poll(() => output[1]?.length ?? 0).toBeGreaterThan(0);
  await run('printf "<tab>%s</tab>\\n" "${DIFFLE_TAB_TEST:-second}"');
  await expect.poll(() => output[1]).toContain('<tab>second</tab>');

  await page.keyboard.press('Control+Backquote');
  await expect(panel).toBeHidden();
  await page.keyboard.press('Control+Backquote');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Terminal 1', exact: true }).click();
  await run('printf "<tab>%s</tab>\\n" "$DIFFLE_TAB_TEST"');
  await expect.poll(() => output[0]).toContain('<tab>first</tab>');

  await panel.getByRole('button', { name: 'Close terminal 2', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Terminal 2', exact: true })).toHaveCount(0);
});

test.describe('bracketed terminal paste', () => {
  test.use({ args: ["--terminal=stty raw -echo; printf '\\033[?2004h<paste-ready>'; exec cat"] });

  test('pastes multiline clipboard text as one bracketed input', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const output = capture(page);
    const input: Buffer[] = [];
    page.on('websocket', (socket) => {
      if (!new URL(socket.url()).pathname.endsWith('/api/terminal/socket')) return;
      socket.on('framesent', ({ payload }) => {
        if (Buffer.isBuffer(payload)) input.push(payload);
      });
    });

    await page.reload();
    const panel = page.getByRole('region', { name: 'Terminal panel' });
    await expect(panel.locator('canvas')).toBeVisible();
    await expect.poll(() => output.get('1')).toContain('<paste-ready>');
    const pasted = 'first line\nsecond line\nthird line';
    await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
    await page.keyboard.press('Control+Shift+V');
    await expect.poll(() => Buffer.concat(input).toString()).toBe(`\x1b[200~${pasted}\x1b[201~`);
  });
});

test.describe('startup split panes', () => {
  test.use({ args: ["--terminal=printf '<startup>%s</startup>\\n' 'codex\\,ready'; exec /bin/sh,"] });

  test('runs a startup command and a plain shell side by side in one tab', async ({ page }) => {
    const output = capture(page);
    await page.reload();
    const panel = page.getByRole('region', { name: 'Terminal panel' });
    const left = panel.locator('[data-terminal-pane="1"]');
    const right = panel.locator('[data-terminal-pane="2"]');
    await expect(panel.getByRole('button', { name: /^Terminal \d+$/ })).toHaveCount(1);
    await expect(left.locator(':focus')).toHaveCount(1);
    await expect(right.locator('canvas')).toBeVisible();
    expect((await right.boundingBox())!.x).toBeGreaterThan((await left.boundingBox())!.x);
    await expect.poll(() => output.get('1')).toContain('<startup>codex,ready</startup>');

    await page.keyboard.press('Alt+Shift+L');
    await expect(right.locator(':focus')).toHaveCount(1);
    await page.keyboard.type('printf "<shell>%s</shell>\\n" shell-ready');
    await page.keyboard.press('Enter');
    await expect.poll(() => output.get('2')).toContain('<shell>shell-ready</shell>');
    expect(output.get('2')).not.toContain('<startup>');
  });
});

test.describe('startup terminals and splits', () => {
  test.use({
    args: ["--terminal=printf '<startup>%s</startup>\\n' codex; exec /bin/sh", '--terminal', '--keep-alive'],
  });

  test('opens ordered tabs and moves focus between tabs and splits', async ({ page }) => {
    const output = capture(page);
    await page.reload();
    const panel = page.getByRole('region', { name: 'Terminal panel' });
    const first = panel.getByRole('button', { name: 'Terminal 1', exact: true });
    const second = panel.getByRole('button', { name: 'Terminal 2', exact: true });
    const pane = (id: number) => panel.locator(`[data-terminal-pane="${id}"]`);
    const focused = (id: number) => pane(id).locator(':focus');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(second).toHaveAttribute('aria-pressed', 'false');
    await expect(focused(1)).toHaveCount(1);
    await expect.poll(() => output.get('1')?.length ?? 0).toBeGreaterThan(0);
    await expect.poll(() => output.get('1')).toContain('<startup>codex</startup>');
    await expect.poll(() => output.get('2')?.length ?? 0).toBeGreaterThan(0);
    expect(output.get('2')).not.toContain('<startup>');

    await page.keyboard.press('Alt+Shift+J');
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(focused(2)).toHaveCount(1);
    await panel.getByRole('button', { name: 'Split terminal right' }).click();
    await expect(focused(3)).toHaveCount(1);
    const left = await pane(2).boundingBox();
    const right = await pane(3).boundingBox();
    expect(right!.x).toBeGreaterThan(left!.x);

    await page.keyboard.press('Alt+Shift+H');
    await expect(focused(2)).toHaveCount(1);
    await page.keyboard.press('Alt+Shift+L');
    await expect(focused(3)).toHaveCount(1);
    await page.keyboard.press('Alt+Shift+K');
    await expect(focused(1)).toHaveCount(1);
    await page.keyboard.press('Alt+Shift+J');
    await expect(focused(3)).toHaveCount(1);
    await page.keyboard.press('Control+Backquote');
    await expect(panel).toBeHidden();
    await page.keyboard.press('Alt+Shift+G');
    await expect(panel).toBeVisible();
    await expect(focused(3)).toHaveCount(1);
    await second.focus();
    await page.keyboard.press('Alt+Shift+G');
    await expect(focused(3)).toHaveCount(1);
    await panel.getByRole('button', { name: 'Close active terminal pane' }).click();
    await expect(pane(3)).toHaveCount(0);
    await expect(focused(2)).toHaveCount(1);
  });

  test('reopens the running shells, split layout, and review location in a fresh browser context', async ({
    page,
    browser,
    diffle,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const output = capture(page);
    await page.reload();
    const panel = page.getByRole('region', { name: 'Terminal panel' });
    await expect.poll(() => output.get('1')).toContain('<startup>codex</startup>');
    await expect(panel.locator('[data-terminal-pane="1"] :focus')).toHaveCount(1);
    await run(page, 'export DIFFLE_SESSION=kept; printf "<pid>%s</pid>\\n" "$$"');
    await expect.poll(() => output.get('1')).toMatch(/<pid>\d+<\/pid>/);
    const pid = output.get('1')!.match(/<pid>(\d+)<\/pid>/)![1];
    await panel.getByRole('button', { name: 'Split terminal right' }).click();
    await expect(panel.locator('[data-terminal-pane="3"] :focus')).toHaveCount(1);

    const path = 'tally/ledger.py';
    await gotoFile(page, path);
    const location = async () => {
      const result = await page.request.get(new URL('api/review-location', diffle.url).href);
      return result.status() === 200 ? ((await result.json()) as { path: string; line: number }) : null;
    };
    await expect.poll(location).toMatchObject({ path, line: expect.any(Number) });
    const before = (await location())!.line;
    await page.keyboard.press('j');
    await expect.poll(async () => (await location())?.line).not.toBe(before);
    const { line } = (await location())!;
    const viewport = page.viewportSize();
    await page.close();

    const context = await browser.newContext({ viewport: viewport ?? undefined });
    try {
      const reopened = await context.newPage();
      const replay = capture(reopened);
      await reopened.goto(diffle.url);
      await expect.poll(() => activePath(reopened)).toBe(path);
      const file = reopened.locator('diffs-container').filter({ has: reopened.locator(`[data-path="${path}"]`) });
      await expect(file.locator(`[data-line="${line}"]`).first()).toBeInViewport();
      await expect(reopened.locator('[data-terminal-pane="3"] :focus')).toHaveCount(1);
      await expect(reopened.locator('[data-terminal-pane="1"] canvas')).toBeVisible();
      await expect.poll(() => replay.get('1')).toContain(`<pid>${pid}</pid>`);

      await reopened.keyboard.press('Alt+Shift+H');
      await expect(reopened.locator('[data-terminal-pane="1"] :focus')).toHaveCount(1);
      await reopened.keyboard.type('printf "<alive>%s:%s</alive>\\n" "$DIFFLE_SESSION" "$$"');
      await reopened.keyboard.press('Enter');
      await expect.poll(() => replay.get('1')).toContain(`<alive>kept:${pid}</alive>`);
    } finally {
      await context.close();
    }
  });
});
