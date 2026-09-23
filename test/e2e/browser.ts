import { chromium, type Browser, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Chromium's shared libraries. A headless shell needs libnspr4/libnss3 and friends, which a
 * minimal Linux image lacks. `PLAYWRIGHT_LIBS` overrides; otherwise a local pixi env that
 * provides them is used when present.
 */
function libPath(): string | null {
  const explicit = process.env.PLAYWRIGHT_LIBS;
  if (explicit && existsSync(explicit)) return explicit;
  const fallback = join(homedir(), '.pixi/envs/chromelibs/lib');
  return existsSync(join(fallback, 'libnspr4.so')) ? fallback : null;
}

/** Launch Chromium, adding its shared libraries to the loader path when found. */
export async function openBrowser(): Promise<Browser> {
  const libs = libPath();
  if (libs) process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH ? `${libs}:${process.env.LD_LIBRARY_PATH}` : libs;
  return chromium.launch();
}

/**
 * Wait until the viewer has rendered a line, so captures are not blank. Attached, not visible:
 * the first number cell can be a zero-size one, and a review of binary files alone has none.
 */
export async function waitForViewer(page: Page): Promise<void> {
  await page.locator('.codeview').waitFor({ timeout: 15000 });
  await page
    .locator('[data-column-number]')
    .first()
    .waitFor({ state: 'attached', timeout: 5000 })
    .catch(() => {});
}

/** The bundled fonts and the first render, for a page that was opened outside `newPage`. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await waitForViewer(page);
}

export interface PageOptions {
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
  /** Capture DPR: 2 rasterizes glyphs at 2x, so a crop stays crisp on a HiDPI display. */
  scale?: number;
}

/**
 * Open a page on `url` at a desktop viewport. `scale` only changes `crop`/`clip` output size;
 * Playwright boxes and mouse coordinates stay in CSS pixels.
 */
export async function newPage(
  browser: Browser,
  url: string,
  { width = 1440, height = 900, colorScheme = 'light', scale = 2 }: PageOptions = {},
): Promise<Page> {
  const context = await browser.newContext({ colorScheme, deviceScaleFactor: scale, viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url);
  await settle(page);
  return page;
}

/** Changed files in the order the tree lists them, the order the verbs below index by. */
export async function filePaths(page: Page): Promise<string[]> {
  return page
    .locator('file-tree-container [data-item-type="file"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item-path') ?? ''));
}

/**
 * The rendered file, a `diffs-container` holding the header and the viewed and collapse controls.
 * Found by the path its header names, not by position, so a file the viewer skips does not shift
 * the mapping for the ones after it. The viewer renders only files near the viewport: move the
 * cursor there first (`gotoFile`, `J`/`K`) for a file further down.
 */
async function fileItem(page: Page, path: string) {
  if (!(await filePaths(page)).includes(path)) throw new Error(`not a changed file: ${path}`);
  const item = page
    .locator('diffs-container')
    .filter({ has: page.locator(`[slot="header-custom"] [data-path=${JSON.stringify(path)}]`) })
    .first();
  await item.waitFor({ state: 'attached', timeout: 5000 });
  return item;
}

/** The file header's content (path, counts, badges and controls), for reading or clicking. */
export async function header(page: Page, path: string) {
  return (await fileItem(page, path)).locator('[slot="header-custom"]');
}

/** Wait for syntax-colored tokens in a rendered source file, excluding plaintext and placeholders. */
export async function waitForHighlight(page: Page, path: string): Promise<void> {
  await (
    await fileItem(page, path)
  )
    .locator('span[data-char][style*="--diffs-token-"]')
    .first()
    .waitFor({ state: 'attached', timeout: 15000 });
}

/** Whether the file is marked viewed. */
export async function viewed(page: Page, path: string): Promise<boolean> {
  return (await fileItem(page, path)).locator('input[type="checkbox"]').isChecked();
}

/**
 * The file the cursor is in, read from the tree's selected row. Before the first navigation nothing
 * is selected, so this falls back to the first changed file, the cursor's default home. Reading the
 * tree rather than the viewer means it also reports files with no diff container (binary, oversized).
 */
export async function activePath(page: Page): Promise<string | null> {
  const row = page.locator('file-tree-container [data-item-type="file"][aria-selected="true"]').first();
  if (await row.count()) return row.getAttribute('data-item-path');
  return (await filePaths(page))[0] ?? null;
}

/**
 * Move the cursor to `path` by clicking its file-tree row: the app selects the file, expands it if
 * collapsed, and hands focus to the review pane. Deterministic where counting `J` presses is not.
 * Needs the tree visible (`Ctrl+B` toggles it); a hidden tree has no row to click.
 */
export async function gotoFile(page: Page, path: string): Promise<void> {
  const row = page.locator(`file-tree-container [data-item-type="file"][data-item-path=${JSON.stringify(path)}]`);
  if ((await row.count()) === 0) throw new Error(`not a changed file: ${path}`);
  await row.first().click();
  for (let i = 0; i < 50; i++) {
    if ((await activePath(page)) === path) return settleScroll(page, path);
    await page.waitForTimeout(100);
  }
  throw new Error(`did not move the cursor to ${path}`);
}

/**
 * Wait until `path`'s header stops moving. A jump lands on an estimated layout and the viewer
 * reissues the measured offset once the files above it have rendered; a capture taken between
 * the two differs from run to run.
 */
async function settleScroll(page: Page, path: string): Promise<void> {
  const top = async () => (await (await header(page, path)).boundingBox())?.y;
  let last = await top();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await top();
    if (now === last) return;
    last = now;
  }
}

/**
 * Move the cursor to `path` with `J`/`K`, the way a reader walks the review. Unlike `gotoFile`
 * this leaves a collapsed file collapsed, so it is the way to look at one without opening it.
 * The review pane must have focus, as it does after load.
 */
export async function walkToFile(page: Page, path: string): Promise<void> {
  const paths = await filePaths(page);
  const target = paths.indexOf(path);
  if (target === -1) throw new Error(`not a changed file: ${path}`);
  for (let i = 0; i < paths.length * 2; i++) {
    const current = paths.indexOf((await activePath(page)) ?? '');
    if (current === target) return;
    await page.keyboard.press(current < target ? 'J' : 'K');
    await page.waitForTimeout(50);
  }
  throw new Error(`did not walk the cursor to ${path}`);
}

/** Whether the file's diff is collapsed. A collapsed file renders no line-number rows. */
export async function collapsed(page: Page, path: string): Promise<boolean> {
  return (await (await fileItem(page, path)).locator('[data-column-number]').count()) === 0;
}

/**
 * Mark the file viewed or unviewed, the same toggle the header label drives. Viewing also collapses
 * the file and moves the cursor to the next unviewed file. Blurs the checkbox afterwards: it is an
 * `INPUT`, and the keymap ignores keys while one has focus, so a later `J`/`v` would silently no-op.
 */
export async function setViewed(page: Page, path: string, on: boolean): Promise<void> {
  const box = (await fileItem(page, path)).locator('input[type="checkbox"]');
  if ((await box.isChecked()) !== on) {
    await box.click();
    await box.blur();
  }
}

/** Collapse or expand the file's diff. Moves the cursor, like a header click. */
export async function toggleCollapse(page: Page, path: string): Promise<void> {
  await (await fileItem(page, path)).locator('button[title="Collapse / expand"]').click();
}

/** The number cell of `number` on `side`: in split view the same number appears on both sides. */
async function cellBox(root: ReturnType<Page['locator']>, number: number, side: 'old' | 'new') {
  const boxes = await root.locator('[data-column-number]').evaluateAll(
    (cells, wanted) =>
      cells
        .filter((cell) => cell.getAttribute('data-column-number') === wanted)
        .map((cell) => cell.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
        .map(({ x, y, width, height }) => ({ x, y, width, height })),
    String(number),
  );
  const wantRight = side !== 'old';
  let best: { x: number; y: number; width: number; height: number } | null = null;
  for (const box of boxes) if (best === null || (wantRight ? box.x > best.x : box.x < best.x)) best = box;
  if (!best) throw new Error(`line ${number} not found on the ${side} side`);
  return best;
}

/**
 * Select `path`'s line range by dragging its number column, which opens the comment composer.
 * `path` scopes the drag: line numbers repeat across files, and an unscoped search picks the
 * first file that has the line rather than the one the cursor is in. The number cells live in the
 * viewer's shadow DOM; Playwright locators pierce it.
 */
export async function selectLines(
  page: Page,
  path: string,
  from: number,
  to: number,
  side: 'old' | 'new' = 'new',
): Promise<void> {
  const root = await fileItem(page, path);
  await root.locator('[data-column-number]').first().waitFor({ timeout: 15000 });
  const start = await cellBox(root, from, side);
  const end = await cellBox(root, to, side);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height - 4, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

/**
 * Rest the pointer on a token starting with `text`, the way a reader hovers a symbol: the first one
 * on `side` (new by default, the side a language server can answer for), inside `path` or anywhere
 * rendered. The viewer arms the tooltip on pointer movement inside the token, so a plain `hover()`
 * (one move onto the centre) shows nothing; a short drift inside the token does.
 */
export async function hoverSymbol(
  page: Page,
  text: string,
  { path, side = 'new' }: { path?: string; side?: 'old' | 'new' } = {},
): Promise<void> {
  const root = path ? await fileItem(page, path) : page;
  const pattern = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const tokens = root.locator('span[data-char]', { hasText: pattern });
  const boxes = await tokens.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      // The column the token sits in: past the midpoint of its diff container in split view.
      const container = element.closest('[data-diff]') ?? element.closest('diffs-container');
      const middle = container ? container.getBoundingClientRect().x + container.getBoundingClientRect().width / 2 : 0;
      return { x, y, width, height, right: x >= middle };
    }),
  );
  const box = boxes.find((b) => b.width > 0 && b.right === (side === 'new'));
  if (!box) throw new Error(`no token starting with ${text} on the ${side} side`);
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + Math.min(8, box.width - 2), box.y + box.height / 2, { steps: 3 });
}

/** Open the compare menu and pick an entry ("Working", "Two refs", "Last commits", "PR"). */
export async function openModePicker(page: Page, entry?: string) {
  await page.getByTitle(/Change what is compared/).click();
  const menu = page.locator('#mode-picker');
  await menu.waitFor();
  if (entry) await menu.locator('button', { hasText: entry }).first().click();
  await page.waitForTimeout(300);
  return menu;
}
