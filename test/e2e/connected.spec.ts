import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { activePath, collapsed, filePaths, gotoFile } from './browser.js';
import { REPO_ROOT, waitForLsp } from './server.js';

// The default comparison (main...feature/refunds) against a fake Python server answering the scripted
// graph in connected.graph.json. By that script:
//   cluster 1 "tally": ledger.py and refunds.py reference one another's changed symbols;
//   cluster 2 "tests": the two test files do;
//   unlinked: cli.py and currency.py, graphed but linked to nothing;
//   other: the eleven files no server graphs (data, binaries, scripts, the generated and deleted ones);
//   context: the unchanged tally/__init__.py calls cluster 1's Entry (lines 1 and 3); cluster 2 has no callers.
const CLUSTER = ['tally/ledger.py', 'tally/refunds.py'];
const SECOND = ['tests/test_ledger.py', 'tests/test_refunds.py'];
const UNLINKED = ['tally/cli.py', 'tally/currency.py'];
const OTHER = [
  'VERSION',
  'assets/logo.png',
  'docs/guide/Übersicht.md',
  'requirements.lock',
  'scripts/build.bat',
  'scripts/tally.sh',
  'tally/generated/openapi.py',
  'tally/legacy.py',
  'tally/py.typed',
  'tally/schema.json',
  'web/vendor/sparkline.min.js',
];
const CALLER = 'tally/__init__.py';
const ANALYZING = /Analy[sz]ing references/;

const scope = (page: Page, name: 'Changed' | 'All files' | 'Connected') =>
  page.getByRole('button', { name, exact: true });
const groups = (page: Page) => page.getByRole('region', { name: 'Feature clusters' });
const rows = (page: Page) => groups(page).getByRole('listitem');
/** The group row named by its accessible name: "ledger.py, in tally, 2 changed files, 1 unchanged caller", "Other (11)". */
const group = (page: Page, name: RegExp) => groups(page).getByRole('button', { name });
const FIRST = /^ledger\.py, in tally, 2 changed files, 1 unchanged caller$/;
const SECOND_ROW = /^tests, 2 changed files, 0 unchanged callers$/;
const UNLINKED_ROW = /^Unlinked \(2\)$/;
const OTHER_ROW = /^Other \(11\)$/;
const contextToggle = (page: Page) => page.getByRole('button', { name: '+ context' });
const tree = (page: Page) => page.locator('aside.tree-theme');

/** The files whose headers the review pane renders, sorted. */
async function reviewed(page: Page): Promise<string[]> {
  const paths = await page
    .locator('[slot="header-custom"] [data-path]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-path') ?? ''));
  return [...new Set(paths)].sort();
}

const treeFiles = async (page: Page) => (await filePaths(page)).sort();

/**
 * The review renders only the files near the viewport, so a narrowed pane is judged by what it never
 * shows: the tree lists exactly the group, its first file is up, and no header belongs to another file.
 */
async function expectReviewOnly(page: Page, members: string[]): Promise<void> {
  await expect.poll(() => treeFiles(page)).toEqual([...members].sort());
  const [first] = await filePaths(page);
  await expect.poll(() => reviewed(page)).toContain(first);
  expect((await reviewed(page)).filter((path) => !members.includes(path))).toEqual([]);
}

/** Switch the tree to Connected and wait for the group list. */
async function chooseConnected(page: Page): Promise<void> {
  await scope(page, 'Connected').click();
  await expect(group(page, FIRST)).toBeVisible();
}

/** The review pane takes the keys again after a click on the tree's controls. */
async function backToReview(page: Page): Promise<void> {
  await page.locator('main[tabindex]').focus();
}

test.describe('with a language server that answers a scripted code graph', () => {
  test.use({
    args: [
      '--lsp',
      `python=${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO_ROOT, 'test/lsp/fake-lsp.mjs'))}`,
    ],
    // A bare PATH keeps a developer's installed servers out of the other languages' answers.
    env: { PATH: '/usr/bin:/bin', FAKE_LSP_GRAPH: join(REPO_ROOT, 'test/e2e/connected.graph.json') },
  });

  test('the tree offers a third scope that lists the clusters once the references are analyzed', async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await expect(scope(page, 'Changed')).toHaveAttribute('aria-pressed', 'true');
    await expect(scope(page, 'All files')).toHaveAttribute('aria-pressed', 'false');
    await expect(scope(page, 'Connected')).toHaveAttribute('aria-pressed', 'false');

    // Hold the answer back so the pending state is on screen, not a race.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/graph', async (route) => {
      await gate;
      await route.continue();
    });
    await scope(page, 'Connected').click();
    await expect(scope(page, 'Connected')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status').filter({ hasText: ANALYZING })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    release();

    await expect(page.getByText(ANALYZING)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(4);
    // Index, the cluster's title (the file its arrows point at), its folder, its changed files and its unchanged callers.
    for (const text of ['1', 'tally', 'ledger.py', '2', '+1']) await expect(rows(page).nth(0)).toContainText(text);
    await expect(rows(page).nth(1)).toContainText('tests');
    await expect(group(page, UNLINKED_ROW)).toBeVisible();
    await expect(group(page, OTHER_ROW)).toBeVisible();
    await expect(group(page, FIRST)).toHaveAttribute('aria-current', 'true');
    await expect(groups(page).locator('button[aria-current]')).toHaveCount(1);
    await expect(tree(page)).toHaveScreenshot('tree-connected.png');
  });

  test('a focused cluster narrows the review; J and K stay inside it, gt and gT move between groups', async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    await expectReviewOnly(page, CLUSTER);

    await gotoFile(page, CLUSTER[0]!);
    // Every file the walk renders, which together are the cluster and nothing else.
    const seen = new Set(await reviewed(page));
    for (const path of CLUSTER.slice(1)) {
      await page.keyboard.press('J');
      await expect.poll(() => activePath(page)).toBe(path);
      await expect.poll(() => reviewed(page)).toContain(path);
      for (const shown of await reviewed(page)) seen.add(shown);
    }
    expect([...seen].sort()).toEqual(CLUSTER);
    // The last file: J finds no further file in the cluster, so the cursor stays among its files.
    await page.keyboard.press('J');
    expect(CLUSTER).toContain(await activePath(page));
    for (let i = 0; i < CLUSTER.length + 1; i++) await page.keyboard.press('K');
    expect(CLUSTER).toContain(await activePath(page));
    await expectReviewOnly(page, CLUSTER);
    await expect(page).toHaveScreenshot('cluster-review.png');

    await page.keyboard.type('gt');
    await expect(group(page, SECOND_ROW)).toHaveAttribute('aria-current', 'true');
    await expect(group(page, FIRST)).not.toHaveAttribute('aria-current', 'true');
    await expectReviewOnly(page, SECOND);
    await page.keyboard.type('gT');
    await expect(group(page, FIRST)).toHaveAttribute('aria-current', 'true');
    await expectReviewOnly(page, CLUSTER);
    // gT from the first group wraps to the last one, gt from there wraps to the first.
    await page.keyboard.type('gT');
    await expect(group(page, OTHER_ROW)).toHaveAttribute('aria-current', 'true');
    await page.keyboard.type('gt');
    await expect(group(page, FIRST)).toHaveAttribute('aria-current', 'true');
  });

  test('a count before gt jumps to that cluster, and a count past the last lands on the last', async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    await backToReview(page);
    await page.keyboard.type('2gt');
    await expect(group(page, SECOND_ROW)).toHaveAttribute('aria-current', 'true');
    await expectReviewOnly(page, SECOND);
    await page.keyboard.type('1gt');
    await expect(group(page, FIRST)).toHaveAttribute('aria-current', 'true');
    await expectReviewOnly(page, CLUSTER);
    await page.keyboard.type('9gt');
    await expect(group(page, SECOND_ROW)).toHaveAttribute('aria-current', 'true');
  });

  test('gC leaves the Connected scope and enters it again from the keyboard', async ({ page, diffle }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    await backToReview(page);
    await page.keyboard.type('gC');
    await expect(scope(page, 'Changed')).toHaveAttribute('aria-pressed', 'true');
    await expect(groups(page)).toHaveCount(0);
    await expect.poll(async () => (await filePaths(page)).length).toBe(17);
    await page.keyboard.type('gC');
    await expect(scope(page, 'Connected')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows(page)).toHaveCount(4);
    await expectReviewOnly(page, CLUSTER);
  });

  test('gc adds the unchanged caller after the changed files, collapsed, as context', async ({ page, diffle }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    // Mark one file viewed: the count in the tree header must not move when the context joins.
    await gotoFile(page, CLUSTER[0]!);
    await page.keyboard.press('v');
    const unview = tree(page).locator('button[title="Mark all 1 viewed file(s) not viewed"]');
    await expect(unview).toBeVisible();

    await expect(contextToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('gc');
    await expect(contextToggle(page)).toHaveAttribute('aria-pressed', 'true');
    // The tree sorts the caller among the cluster's files; the review lists it after the changed ones.
    await expect.poll(() => treeFiles(page)).toEqual([...CLUSTER, CALLER].sort());
    await expect(unview).toBeVisible();

    await gotoFile(page, CLUSTER[1]!);
    await page.keyboard.press('J');
    await expect.poll(() => activePath(page)).toBe(CALLER);
    await expect.poll(() => reviewed(page)).toContain(CALLER);
    const header = page.locator(`[slot="header-custom"]:has([data-path="${CALLER}"])`);
    await expect(header).toContainText('unchanged context');
    await expect(header).toContainText('Entry ×2 · L1, L3');
    // Not reviewable: no viewed checkbox, and it starts folded.
    await expect(header.locator('input[type="checkbox"]')).toHaveCount(0);
    expect(await collapsed(page, CALLER)).toBe(true);

    await page.keyboard.type('zo');
    await expect.poll(() => collapsed(page, CALLER)).toBe(false);
    await expect(page.locator('diffs-container').getByText('__version__').first()).toBeVisible();
    // ] visits the lines that link to the cluster (1 and 3) and nothing between them.
    const cursor = page.locator(`diffs-container:has([data-path="${CALLER}"]) [data-line][data-selected-line]`);
    await page.keyboard.press(']');
    await expect(cursor).toHaveAttribute('data-line', '1');
    await page.keyboard.press(']');
    await expect(cursor).toHaveAttribute('data-line', '3');
    await expect(unview).toBeVisible();
    await expect(page).toHaveScreenshot('context-expanded.png');

    await page.keyboard.type('gc');
    await expect(contextToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => treeFiles(page)).toEqual(CLUSTER);
  });

  test('the Unlinked and Other groups list the loose code files and the files no server graphs', async ({
    page,
    diffle,
  }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    await group(page, UNLINKED_ROW).click();
    await expect(group(page, UNLINKED_ROW)).toHaveAttribute('aria-current', 'true');
    await expect(groups(page)).toContainText('Unlinked: code files no other changed file references');
    await expectReviewOnly(page, UNLINKED);

    await group(page, OTHER_ROW).click();
    await expect(group(page, OTHER_ROW)).toHaveAttribute('aria-current', 'true');
    await expect(groups(page)).toContainText('Other: files no language server could graph');
    await expectReviewOnly(page, OTHER);
    await expect(tree(page)).toHaveScreenshot('tree-other.png');
  });

  test('gc does nothing while a group without callers is focused', async ({ page, diffle }) => {
    await waitForLsp(diffle.url);
    await chooseConnected(page);
    for (const row of [OTHER_ROW, SECOND_ROW]) {
      await group(page, row).click();
      await expect(group(page, row)).toHaveAttribute('aria-current', 'true');
      const before = await treeFiles(page);
      await expect(contextToggle(page)).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.type('gc');
      await expect(contextToggle(page)).toHaveAttribute('aria-pressed', 'false');
      expect(await treeFiles(page)).toEqual(before);
    }
    // Back on the cluster that has a caller, the toggle is live and the earlier presses left no mark.
    await group(page, FIRST).click();
    await expect(contextToggle(page)).not.toHaveAttribute('aria-disabled');
    await expect(contextToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expectReviewOnly(page, CLUSTER);
  });
});

test.describe('without a language server', () => {
  test('Connected files everything under Other with a note and no error', async ({ page }) => {
    await scope(page, 'Connected').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(group(page, /^Other \(17\)$/)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('note')).toContainText('Language servers are off for this run');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/failed|unavailable/i)).toHaveCount(0);
    await expect.poll(async () => (await filePaths(page)).length).toBe(17);
    await expect(contextToggle(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page).toHaveScreenshot('no-language-server.png');
  });
});
