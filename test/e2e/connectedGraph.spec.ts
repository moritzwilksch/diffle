import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { activePath, filePaths, gotoFile } from './browser.js';
import { REPO_ROOT, waitForLsp } from './server.js';

// The default comparison against a fake Python server answering the scripted graph in connectedGraph.graph.json.
// By that script the five code files below form ONE cluster (nine links, ledger.py and refunds.py use each other),
// the unchanged tally/__init__.py calls into it, cli.py is Unlinked, and eleven files are Other:
//   refunds -> currency, ledger -> currency, refunds <-> ledger, test_ledger -> ledger / refunds / test_refunds,
//   test_refunds -> ledger / refunds.
const CLUSTER = [
  'tally/currency.py',
  'tally/ledger.py',
  'tally/refunds.py',
  'tests/test_ledger.py',
  'tests/test_refunds.py',
];
const CALLER = 'tally/__init__.py';
// The file most arrow weight points at, not a test: the cluster's title.
const TITLE = 'ledger.py';
const CLUSTER_ROW = /, 5 changed files, 1 unchanged caller$/;
const UNLINKED_ROW = /^Unlinked \(1\)$/;
const OTHER_ROW = /^Other \(11\)$/;
const COUNTS = '5 files · 9 links · 1 unchanged caller (hidden)';
const COUNTS_WITH_CONTEXT = '5 files · 9 links · 1 unchanged caller';
const LEDGER = /^ledger\.py, modified, \+\d+ -\d+, uses 2 files, used by 3 files$/;

const group = (page: Page, name: RegExp) =>
  page.getByRole('region', { name: 'Feature clusters' }).getByRole('button', { name });
const graphButton = (page: Page) => page.getByRole('button', { name: 'Graph', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Connected files' });
const canvas = (page: Page) => dialog(page).getByRole('group', { name: /^Dependency graph/ });
const details = (page: Page) => dialog(page).getByRole('complementary', { name: 'Details' });
/** A file's card, by the file name its accessible name starts with. */
const card = (page: Page, file: string) =>
  dialog(page).getByRole('button', { name: new RegExp(`^${file.replace('.', '\\.')},`) });
const contextChip = (page: Page) => dialog(page).getByRole('button', { name: '+ context' });
const focusedCard = (page: Page) => dialog(page).locator('[data-node-id]:focus');
const cursorRow = (page: Page) => page.locator('file-tree-container [data-item-type="file"][aria-selected="true"]');

/** Switch the tree to Connected and wait for the cluster. */
async function chooseConnected(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connected', exact: true }).click();
  await expect(group(page, CLUSTER_ROW)).toHaveAttribute('aria-current', 'true');
}

/** Open the focused cluster's graph with its Graph button and wait until all five cards are drawn. */
async function openGraph(page: Page, url: string): Promise<void> {
  await waitForLsp(url);
  await chooseConnected(page);
  await graphButton(page).click();
  await expect(canvas(page)).toBeVisible();
  await expect(dialog(page).locator('[data-node-id]')).toHaveCount(CLUSTER.length);
}

/** The names of the files a detail section (Uses, Used by) lists, in order. */
const listed = (page: Page, section: 'Uses' | 'Used by') =>
  details(page).getByRole('region', { name: section }).getByRole('button').locator('span.font-medium > span.truncate');

test.describe('the Connected graph over a scripted code graph', () => {
  test.use({
    args: [
      '--lsp',
      `python=${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}`,
    ],
    // A bare PATH keeps a developer's installed servers out of the other languages' answers.
    env: { PATH: '/usr/bin:/bin', FAKE_LSP_GRAPH: join(REPO_ROOT, 'test/e2e/connectedGraph.graph.json') },
  });

  test('the Graph button draws the cluster as one card per file, with one tab stop', async ({ page, diffle }) => {
    await openGraph(page, diffle.url);
    await expect(dialog(page).getByText(COUNTS, { exact: true })).toBeVisible();
    await expect(dialog(page)).toContainText('Connected files');
    await expect(canvas(page)).toHaveAccessibleName('Dependency graph: 5 files, 9 links');

    await expect(card(page, 'ledger.py')).toHaveAccessibleName(LEDGER);
    await expect(card(page, 'refunds.py')).toHaveAccessibleName(
      /^refunds\.py, added, \+32 -0, uses 2 files, used by 3 files$/,
    );
    await expect(card(page, 'currency.py')).toHaveAccessibleName(
      /^currency\.py, renamed, \+\d+ -\d+, uses 0 files, used by 2 files$/,
    );
    await expect(card(page, 'test_ledger.py')).toHaveAccessibleName(
      /^test_ledger\.py, test, modified, \+13 -0, uses 3 files, used by 0 files$/,
    );
    await expect(card(page, 'test_refunds.py')).toHaveAccessibleName(
      /^test_refunds\.py, test, added, \+20 -0, uses 2 files, used by 1 file$/,
    );
    // Roving tabindex: exactly one card is in the tab order.
    await expect(dialog(page).locator('[data-node-id][tabindex="0"]')).toHaveCount(1);
    await expect(dialog(page).locator('[data-node-id][tabindex="-1"]')).toHaveCount(CLUSTER.length - 1);
    // No file outside the cluster is drawn while `+ context` is off.
    await expect(dialog(page).locator(`[data-node-id="${CALLER}"]`)).toHaveCount(0);
    await expect(page).toHaveScreenshot('graph-dialog.png');
    // The legend explains the test cards.
    await dialog(page).getByRole('button', { name: 'Legend' }).click();
    await expect(dialog(page).getByRole('region', { name: 'Legend' })).toContainText('Test file');
  });

  test('the keyboard walks along the arrows, Space selects, and a detail row shows an arrow’s symbols', async ({
    page,
    diffle,
  }) => {
    await openGraph(page, diffle.url);
    // Focus lands on the canvas: the card with the most links, ledger.py.
    await expect(focusedCard(page)).toHaveAttribute('data-node-id', 'tally/ledger.py');

    // Space selects it; the panel names the files it uses and the ones using it.
    await page.keyboard.press('Space');
    await expect(card(page, 'ledger.py')).toHaveAttribute('aria-pressed', 'true');
    await expect(details(page)).toContainText('ledger.py');
    await expect(listed(page, 'Uses')).toHaveText(['currency.py', 'refunds.py']);
    await expect(listed(page, 'Used by')).toHaveText(['refunds.py', 'test_ledger.py', 'test_refunds.py']);
    await expect(page).toHaveScreenshot('graph-selected.png');

    // ArrowRight follows an arrow out to the used file nearest in height, ArrowLeft back to a file that uses it.
    await page.keyboard.press('ArrowRight');
    await expect(focusedCard(page)).toHaveAttribute('data-node-id', 'tally/currency.py');
    await page.keyboard.press('ArrowLeft');
    await expect(focusedCard(page)).toHaveAttribute('data-node-id', 'tally/ledger.py');
    await page.keyboard.press('ArrowLeft');
    await expect(focusedCard(page)).toHaveAttribute('data-node-id', 'tally/refunds.py');
    // Down walks on in reading order (ranks left to right, each top to bottom), into the next rank at its end;
    // Up retraces it.
    await page.keyboard.press('ArrowDown');
    await expect(focusedCard(page)).not.toHaveAttribute('data-node-id', 'tally/refunds.py');
    await page.keyboard.press('ArrowUp');
    await expect(focusedCard(page)).toHaveAttribute('data-node-id', 'tally/refunds.py');

    // Pick the arrow from refunds.py in ledger.py's "Used by": its symbols come with kind icons and lines.
    await card(page, 'ledger.py').focus();
    await details(page)
      .getByRole('region', { name: 'Used by' })
      .getByRole('button', { name: /^Added: refunds\.py/ })
      .click();
    await expect(details(page).getByRole('heading', { level: 3 })).toContainText('refunds.py');
    const symbols = details(page).getByRole('region', { name: 'Symbols' });
    await expect(symbols.getByRole('listitem')).toHaveText(['Entryclasslines 13', 'Kindvariablelines 16']);
    await expect(symbols.locator('svg')).toHaveCount(2);
    await expect(page).toHaveScreenshot('graph-edge.png');
  });

  test('the cluster row names the cluster by the file its arrows point at, with the folder beside it', async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    const row = group(page, CLUSTER_ROW);
    await expect(row).toHaveAccessibleName(`${TITLE}, in (root), 5 changed files, 1 unchanged caller`);
    // The title leads; the folder follows it as secondary text, and the title is not repeated.
    await expect(row.locator('span').nth(1)).toHaveText(TITLE);
    await expect(row.locator('span').nth(2)).toHaveText('(root)');
    await expect(row).toContainText(TITLE);
    expect(((await row.textContent()) ?? '').split(TITLE)).toHaveLength(2);
    await graphButton(page).click();
    await expect(dialog(page).getByRole('heading', { level: 3 })).toHaveText(`Connected files${TITLE}`);
  });

  test('Hide tests takes the test cards and their arrows out, and brings them back', async ({ page, diffle }) => {
    await openGraph(page, diffle.url);
    const hide = dialog(page).getByRole('button', { name: 'Hide tests' });
    const arrows = dialog(page).locator("path[data-motion='edge-draw']");
    await expect(hide).toHaveAttribute('aria-pressed', 'false');
    await expect(hide).toHaveAttribute('title', 'Hide the 2 test files');
    await expect(arrows).toHaveCount(9);
    await card(page, 'test_ledger.py').focus();
    await page.keyboard.press('Space');
    await expect(details(page)).toContainText('test_ledger.py');

    await hide.click();
    await expect(hide).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog(page).locator('[data-node-id]')).toHaveCount(CLUSTER.length - 2);
    await expect(card(page, 'test_ledger.py')).toHaveCount(0);
    await expect(card(page, 'test_refunds.py')).toHaveCount(0);
    await expect(arrows).toHaveCount(4);
    await expect(
      dialog(page).getByText('3 files · 4 links · 1 unchanged caller (hidden) · 2 tests hidden', { exact: true }),
    ).toBeVisible();
    // The test card that was selected is gone, so the panel is back at its overview.
    await expect(details(page)).toContainText('How to read it');
    await expect(hide).toHaveAttribute('title', 'Show the 2 test files again');
    await expect(page).toHaveScreenshot('graph-tests-hidden.png');

    await hide.click();
    await expect(hide).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog(page).locator('[data-node-id]')).toHaveCount(CLUSTER.length);
    await expect(arrows).toHaveCount(9);
    await expect(dialog(page).getByText(COUNTS, { exact: true })).toBeVisible();
  });

  test('an arrow reads as a sentence in the panel and in the example', async ({ page, diffle }) => {
    await openGraph(page, diffle.url);
    // The overview's worked example is its strongest arrow, in words.
    await expect(details(page).getByText(/^Example: \S+ uses .+ from \S+$/)).toBeVisible();
    await card(page, 'ledger.py').focus();
    await page.keyboard.press('Space');
    await details(page)
      .getByRole('region', { name: 'Used by' })
      .getByRole('button', { name: /^Added: refunds\.py/ })
      .click();
    await expect(details(page).getByRole('heading', { level: 3 })).toHaveText(
      'refunds.py uses Entry and Kind from ledger.py',
    );
    await expect(dialog(page).getByRole('status')).toHaveText(
      'Selected arrow: refunds.py uses Entry and Kind from ledger.py',
    );
  });

  test('Enter on a card closes the dialog and puts the review cursor in that file', async ({ page, diffle }) => {
    await openGraph(page, diffle.url);
    await card(page, 'refunds.py').focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => activePath(page)).toBe('tally/refunds.py');
    await expect(cursorRow(page)).toHaveAttribute('data-item-path', 'tally/refunds.py');
    // The review has the keys again: J moves to the next file of the cluster.
    await expect(page.locator('main[tabindex]')).toBeFocused();
    await page.keyboard.press('J');
    await expect.poll(() => activePath(page)).not.toBe('tally/refunds.py');
    expect(CLUSTER).toContain(await activePath(page));
  });

  test('+ context in the dialog draws the unchanged caller dashed, and the review follows', async ({
    page,
    diffle,
  }) => {
    await openGraph(page, diffle.url);
    await expect(contextChip(page)).toHaveAttribute('aria-pressed', 'false');
    await contextChip(page).click();
    await expect(contextChip(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(card(page, '__init__.py')).toHaveAccessibleName(
      /^__init__\.py, unchanged caller, uses 1 file, used by 0 files$/,
    );
    await expect(dialog(page).locator('[data-node-id]')).toHaveCount(CLUSTER.length + 1);
    await expect(dialog(page).getByText(COUNTS_WITH_CONTEXT, { exact: true })).toBeVisible();
    // The unchanged caller's arrow keeps its pixel dashes (a unit pathLength would swallow them); others are solid.
    const dash = (el: Element) => getComputedStyle(el).strokeDasharray;
    expect(await dialog(page).locator("path[data-motion='edge-fade']").first().evaluate(dash)).toBe('6px, 5px');
    expect(await dialog(page).locator("path[data-motion='edge-draw']").first().evaluate(dash)).not.toBe('6px, 5px');
    await expect(page).toHaveScreenshot('graph-context.png');
    // The cluster bar's own toggle and the tree list the caller as well.
    await expect.poll(async () => (await filePaths(page)).sort()).toEqual([...CLUSTER, CALLER].sort());

    await contextChip(page).click();
    await expect(contextChip(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog(page).locator('[data-node-id]')).toHaveCount(CLUSTER.length);
    await expect(dialog(page).locator(`[data-node-id="${CALLER}"]`)).toHaveCount(0);
    await expect.poll(async () => (await filePaths(page)).sort()).toEqual(CLUSTER);
  });

  test('gm opens it only on a cluster; Escape closes it and returns focus; j and k stay out of the review', async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);

    // Unlinked and Other have no graph: the key does nothing and the button says why.
    for (const row of [UNLINKED_ROW, OTHER_ROW]) {
      await group(page, row).click();
      await expect(group(page, row)).toHaveAttribute('aria-current', 'true');
      await expect(graphButton(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(graphButton(page)).toHaveAttribute('title', 'Pick a cluster: only linked files can be drawn');
      await page.locator('main[tabindex]').focus();
      await page.keyboard.type('gm');
      await expect(dialog(page)).toHaveCount(0);
      // Playwright treats aria-disabled as not actionable, so the press is forced through.
      await graphButton(page).click({ force: true });
      await expect(dialog(page)).toHaveCount(0);
    }

    await group(page, CLUSTER_ROW).click();
    await expect(graphButton(page)).not.toHaveAttribute('aria-disabled');
    await expect(graphButton(page)).toHaveAttribute('title', 'Show how this cluster’s files connect (gm)');
    await gotoFile(page, 'tally/ledger.py');
    await page.keyboard.type('gm');
    await expect(canvas(page)).toBeVisible();
    await expect(focusedCard(page)).toHaveCount(1);

    // The review behind the dialog does not move.
    for (const key of ['j', 'k', 'J', 'K']) await page.keyboard.press(key);
    expect(await activePath(page)).toBe('tally/ledger.py');

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('main[tabindex]')).toBeFocused();
    // The key works again after the dialog is gone.
    await page.keyboard.press('J');
    await expect.poll(() => activePath(page)).toBe('tally/refunds.py');
  });

  test('the cards enter with a staggered animation, and reduced motion turns every motion off', async ({
    page,
    diffle,
  }) => {
    await openGraph(page, diffle.url);
    const style = (target: Locator, property: 'animationName' | 'transitionDuration') =>
      target.evaluate((el, p) => getComputedStyle(el)[p], property);
    const enter = dialog(page).locator("[data-motion='node-in']").first();
    expect(await style(enter, 'animationName')).toBe('graph-rise');
    // The nodes rise and fade only: blur on dozens of SVG groups is left to the panel.
    expect(await enter.evaluate((el) => getComputedStyle(el).filter)).toBe('none');
    expect(await style(dialog(page), 'transitionDuration')).not.toBe('0s');
    // The shared backdrop is found by the graph popup that follows it, and fades with it.
    const backdrop = page.locator("[data-slot='dialog-overlay']");
    expect(await style(backdrop, 'transitionDuration')).not.toBe('0s');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await graphButton(page).click();
    await expect(canvas(page)).toBeVisible();
    expect(await style(enter, 'animationName')).toBe('none');
    expect(await style(dialog(page).locator("[data-motion='node']").first(), 'transitionDuration')).toBe('0s');
    expect(await style(dialog(page), 'transitionDuration')).toBe('0s');
    expect(await style(backdrop, 'transitionDuration')).toBe('0s');
    expect(await style(dialog(page).locator("[data-motion='edge-draw']").first(), 'animationName')).toBe('none');
  });

  test('a chunk that fails to load reports it, leaves the keys alone, and the next open retries', async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    const chunk = '**/assets/GraphDialog-*.js';
    await page.route(chunk, (route) => route.abort());
    await gotoFile(page, 'tally/ledger.py');
    await page.keyboard.type('gm');
    await expect(page.getByText(/^Loading the graph failed/)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    // The keymap is not stuck in "dialog open": j and k move the cursor again.
    await page.keyboard.press('J');
    await expect.poll(() => activePath(page)).not.toBe('tally/ledger.py');

    await page.unroute(chunk);
    await page.keyboard.type('gm');
    await expect(canvas(page)).toBeVisible();
    await expect(dialog(page).locator('[data-node-id]')).toHaveCount(CLUSTER.length);
  });

  test('the first open enters with the dialog transition, not already open', async ({ page, diffle }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    await page.evaluate(() => {
      document.addEventListener(
        'transitionrun',
        (e) => {
          if ((e.target as HTMLElement).dataset.motion !== 'dialog') return;
          const runs = Number(document.documentElement.dataset.dialogRuns ?? 0);
          document.documentElement.dataset.dialogRuns = String(runs + 1);
        },
        true,
      );
    });
    await graphButton(page).click();
    await expect(canvas(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Number(document.documentElement.dataset.dialogRuns ?? 0)))
      .toBeGreaterThan(0);
  });

  test.describe('in the dark theme', () => {
    test.use({ colorScheme: 'dark' });

    test('the graph keeps its contrast', async ({ page, diffle }) => {
      await openGraph(page, diffle.url);
      await page.keyboard.press('Space');
      await expect(page).toHaveScreenshot('graph-dark.png');
    });
  });

  test.describe('in a narrow window', () => {
    test.use({ viewport: { width: 800, height: 900 } });

    test('the detail panel stacks under the canvas, and its buttons stay reachable', async ({ page, diffle }) => {
      await openGraph(page, diffle.url);
      await expect(details(page)).toBeVisible();
      const [above, below] = await Promise.all([canvas(page).boundingBox(), details(page).boundingBox()]);
      expect(below!.y).toBeGreaterThanOrEqual(above!.y + above!.height - 1);
      expect(below!.height).toBeLessThanOrEqual(900 * 0.4);

      await page.keyboard.press('Space');
      await expect(dialog(page).getByRole('status')).toHaveText(/^ledger\.py selected: uses 2 files, used by 3 files$/);
      await expect(details(page).getByRole('button', { name: 'Open in review' })).toBeVisible();
      await expect(page).toHaveScreenshot('graph-narrow.png');
    });
  });
});

// A second scripted graph (connectedGraphMany.graph.json) over a repository with more files: ledger.py is used by
// four source files (two of them named util.py, one under a long path) and five tests, so its panel folds.
const MANY_SOURCES = ['tally/a/util.py', 'tally/adapters/storage/postgres/migrations/b/util.py', 'tally/report.py'];
const MANY_TESTS = ['tests/test_report.py', 'tests/test_export.py', 'tests/test_audit.py'];
const MANY_FILES = 11;
const MANY_ROW = /, 11 changed files, 0 unchanged callers$/;

/** A small Python module that references Entry (line 7) and parse_row (line 6), where the script points. */
const caller = (fn: string): string =>
  `"""${fn}."""\nfrom tally.ledger import Entry, parse_row\n\n\ndef ${fn}(rows):\n    entries = [parse_row(r) for r in rows]\n    return [e for e in entries if isinstance(e, Entry)]\n`;

/** The panel's scroll is set, not eased, so the picture does not depend on when it is taken. */
const scrollPanelToEnd = (page: Page) => details(page).evaluate((el) => void (el.scrollTop = el.scrollHeight));

/** A list with 8px of the panel around it, so a focus ring is not cut; a whole-panel picture clips its heading. */
const around = async (list: Locator) => {
  const box = (await list.boundingBox())!;
  return { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 };
};

const manyTest = test.extend({
  // The files are committed on the branch under review, so the default comparison shows them as added.
  repo: async ({ repo }, use) => {
    for (const path of [...MANY_SOURCES, ...MANY_TESTS]) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), caller(path.replace(/^.*\//, '').replace('.py', '').replace('util', 'total')));
    }
    // A fixed date, so the commit's hash (shown behind the dialog) is the same on every run.
    const date = '2026-01-15T12:00:00Z';
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...args],
        { cwd: repo, env, stdio: 'ignore' },
      );
    git('add', ...MANY_SOURCES, ...MANY_TESTS);
    git('commit', '-q', '-m', 'feat: more callers of the ledger');
    await use(repo);
  },
});

manyTest.describe('a file with more callers than the panel lists at once', () => {
  manyTest.use({
    args: [
      '--lsp',
      `python=${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}`,
    ],
    env: { PATH: '/usr/bin:/bin', FAKE_LSP_GRAPH: join(REPO_ROOT, 'test/e2e/connectedGraphMany.graph.json') },
  });

  /** Open the graph, select ledger.py and return its "Used by" list. */
  async function selectLedger(page: Page, url: string) {
    await waitForLsp(url);
    await page.getByRole('button', { name: 'Connected', exact: true }).click();
    await expect(group(page, MANY_ROW)).toHaveAttribute('aria-current', 'true');
    await graphButton(page).click();
    await expect(dialog(page).locator('[data-node-id]')).toHaveCount(MANY_FILES);
    await card(page, 'ledger.py').focus();
    await page.keyboard.press('Space');
    return details(page).getByRole('region', { name: 'Used by' });
  }

  manyTest(
    'lists sources before tests, names each file’s folder, and folds the rest behind one button',
    async ({ page, diffle }) => {
      const usedBy = await selectLedger(page, diffle.url);
      const names = usedBy.getByRole('listitem').locator('span.font-medium > span.truncate');
      const more = usedBy.getByRole('button', { name: /^Show (all 9|fewer)$/ });

      // Six of the nine rows: all four sources, then the two strongest tests.
      await expect(usedBy.getByRole('heading', { level: 4 })).toHaveText('Used by (9)');
      await expect(names).toHaveCount(6);
      const first = await names.allTextContents();
      expect(first.slice(0, 4).sort()).toEqual(['refunds.py', 'report.py', 'util.py', 'util.py']);
      expect(first.slice(4).every((n) => n.startsWith('test_'))).toBe(true);
      // The folder sits under the name, so the two util.py differ.
      const dirs = usedBy.getByRole('listitem').locator('bdi');
      await expect(dirs.filter({ hasText: /^tally\/a$/ })).toHaveCount(1);
      const long = dirs.filter({ hasText: /^tally\/adapters\/storage\/postgres\/migrations\/b$/ });
      await expect(long).toHaveCount(1);
      // A path too long for its line loses its start, not its end: the part that tells the files apart stays.
      const clipped = await long.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const room = el.parentElement!.getBoundingClientRect();
        return { startCut: box.left < room.left - 1, endShown: box.right <= room.right + 1 };
      });
      expect(clipped).toEqual({ startCut: true, endShown: true });
      // A test row carries the tag; the accessible name says "test", and the status is text too.
      await expect(usedBy.getByRole('button', { name: /^Added: test_\w+\.py test / }).first()).toBeVisible();
      await expect(usedBy.getByText('test', { exact: true })).toHaveCount(2);
      // Three symbols at most, then the exact rest: Entry and parse_row are all that links a source to ledger.py.
      await expect(usedBy.getByRole('button', { name: /^Added: report\.py / })).toContainText('Entry');
      await expect(more).toHaveText('Show all 9');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await scrollPanelToEnd(page);
      await expect(page).toHaveScreenshot('graph-used-by.png', { clip: await around(usedBy) });

      // The keyboard: Tab from the last row lands on the button, Enter opens and closes it, focus stays.
      await names.nth(5).locator('xpath=ancestor::button').focus();
      await page.keyboard.press('Tab');
      await expect(more).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(more).toHaveText('Show fewer');
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expect(more).toBeFocused();
      await expect(names).toHaveCount(9);
      const all = await names.allTextContents();
      expect(all.slice(0, 4).every((n) => !n.startsWith('test_'))).toBe(true);
      expect(all.slice(4).every((n) => n.startsWith('test_'))).toBe(true);
      // The canvas keys are not the panel's: an arrow key on the button neither moves nor swallows focus.
      await page.keyboard.press('ArrowRight');
      await expect(more).toBeFocused();
      await scrollPanelToEnd(page);
      await expect(page).toHaveScreenshot('graph-used-by-all.png');
      await page.keyboard.press('Space');
      await expect(more).toHaveText('Show all 9');
      await expect(more).toBeFocused();
      await expect(names).toHaveCount(6);

      // A row drills into its arrow; the panel then shows the sentence, and the selection resets the fold.
      await usedBy.getByRole('button', { name: /^Added: report\.py / }).click();
      await expect(details(page).getByRole('heading', { level: 3 })).toHaveText(
        /^report\.py uses Entry and parse_row from ledger\.py$/,
      );
    },
  );

  manyTest('says why a list is empty, and offers no button for a short one', async ({ page, diffle }) => {
    await selectLedger(page, diffle.url);
    await card(page, 'test_export.py').focus();
    await page.keyboard.press('Space');
    const usedBy = details(page).getByRole('region', { name: 'Used by' });
    await expect(usedBy).toContainText('Nothing drawn uses it.');
    await expect(usedBy.getByRole('button')).toHaveCount(0);
    const uses = details(page).getByRole('region', { name: 'Uses' });
    await expect(uses.getByRole('button', { name: /^Modified: ledger\.py/ })).toBeVisible();
    await expect(uses.getByRole('button', { name: /Show/ })).toHaveCount(0);
  });

  manyTest.describe('in the dark theme', () => {
    manyTest.use({ colorScheme: 'dark' });

    manyTest('keeps its contrast', async ({ page, diffle }) => {
      const usedBy = await selectLedger(page, diffle.url);
      await usedBy.getByRole('button', { name: 'Show all 9' }).click();
      await scrollPanelToEnd(page);
      await expect(page).toHaveScreenshot('graph-used-by-dark.png');
    });
  });

  manyTest.describe('in a narrow window', () => {
    manyTest.use({ viewport: { width: 800, height: 900 } });

    manyTest('stays readable under the canvas', async ({ page, diffle }) => {
      await selectLedger(page, diffle.url);
      await expect(page).toHaveScreenshot('graph-used-by-narrow.png');
    });
  });
});
