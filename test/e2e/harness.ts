// Drives a real diffle in a real browser: the e2e tests and the screenshot-change skill share it.
//
// The generic part starts the server, opens pages and records video; the app bundles its fonts,
// so a capture on any host shows the design's type once `document.fonts.ready` resolves.
// The diffle-specific verbs (`header`, `viewed`, `collapsed`, `setViewed`, `toggleCollapse`,
// `activePath`, `gotoFile`, `selectLines`, `openModePicker`) encode where the UI lives, so a
// scenario reads as what a reviewer does rather than as selectors. Verbs that take a path
// index files by tree order; `filePaths` returns that order.
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommentThread, ThreadCreate } from '../../src/shared/protocol.js';

/** The diffle checkout that contains this file. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The client build the server serves. Swap it to screenshot a different build. */
export const CLIENT_DIR = join(REPO_ROOT, 'dist/client');

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

export interface DiffleOptions {
  /** The repository to review; any directory inside a worktree. */
  repo: string;
  /** Revisions or a shorthand, as on the command line. */
  revs?: string[];
  /** Further CLI flags. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunningDiffle {
  url: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Start diffle on `repo` for `revs`, with status noise off. Resolves once stderr names the
 * URL. Call `stop` (or use `withDiffle`) to reap the process.
 */
export async function startDiffle({
  repo,
  revs = [],
  args = [],
  env = {},
  timeoutMs = 30000,
}: DiffleOptions): Promise<RunningDiffle> {
  const proc = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
      join(REPO_ROOT, 'src/cli/main.ts'),
      '-C',
      repo,
      '--port',
      '0',
      '--no-open',
      '--no-watch',
      ...(args.some((a) => a.startsWith('--lsp')) ? [] : ['--no-lsp']),
      ...revs,
      ...args,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  let stdout = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk;
  });
  proc.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk;
  });

  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`diffle did not start in ${timeoutMs}ms\n${stderr}`)), timeoutMs);
    const scan = () => {
      const match = stderr.match(/diffle running at (\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1] ?? '');
    };
    proc.stderr!.on('data', scan);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`diffle exited (${code})\n${stderr}\n${stdout}`));
    });
    scan();
  }).catch((error: unknown) => {
    proc.kill('SIGKILL');
    throw error;
  });

  return {
    url,
    proc,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise<void>((done) => {
        const force = setTimeout(() => {
          proc.kill('SIGKILL');
          done();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(force);
          done();
        });
      });
    },
  };
}

/** Run `fn` with a freshly started diffle, always stopping it afterwards. */
export async function withDiffle<T>(opts: DiffleOptions, fn: (server: RunningDiffle) => Promise<T>): Promise<T> {
  const server = await startDiffle(opts);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

/** Create threads directly: everything the sidebar shows is HTTP state, not UI state. */
export async function seedThreads(url: string, threads: ThreadCreate[]): Promise<CommentThread[]> {
  const response = await fetch(new URL('api/threads', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(threads),
  });
  if (!response.ok) throw new Error(`seeding threads failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as CommentThread[];
}

/** Threads as the client sees them, for asserting that a comment landed where the script meant it to. */
export async function readThreads(url: string): Promise<CommentThread[]> {
  const response = await fetch(new URL('api/threads', url));
  if (!response.ok) throw new Error(`reading threads failed: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as CommentThread[];
}

/** Wait until every language server diffle started reports ready, so a hover gets an answer. */
export async function waitForLsp(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(new URL('api/lsp/status', url));
    const status = (await response.json()) as { servers: { state: string }[] };
    if (status.servers.length > 0 && status.servers.every((s) => s.state === 'ready')) return;
    if (Date.now() > deadline) throw new Error(`language servers not ready: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The prompt the open comments export as, the text `yy` copies. */
export async function readPrompt(url: string): Promise<string> {
  const response = await fetch(new URL('api/threads/export?state=open', url));
  if (!response.ok) throw new Error(`reading the prompt failed: HTTP ${response.status} ${await response.text()}`);
  return response.text();
}

/**
 * Delete the review state (viewed, collapsed, threads) that diffle keeps under `<git-dir>/diffle/`.
 * Call before a take: a stale viewed or collapsed flag silently changes what the recording shows.
 */
export function resetReviewState(repo: string): void {
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  rmSync(join(resolve(repo, gitDir), 'diffle'), { recursive: true, force: true });
}

/** Install a client build (e.g. the base branch's `dist/client`) into the served directory. */
export async function installClient(sourceDir: string): Promise<void> {
  await rm(CLIENT_DIR, { recursive: true, force: true });
  await cp(sourceDir, CLIENT_DIR, { recursive: true });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Build the client in this checkout. Run once per source revision. */
export function buildClient(cwd = REPO_ROOT): void {
  execFileSync(npm, ['run', 'build:client'], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

/**
 * Run `fn` with the served client built from `rev`, then restore this checkout's build and drop
 * the temporary worktree. `rev` reuses this checkout's `node_modules` through a symlink.
 */
export async function withBaseClient<T>(rev: string, fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'diffle-base-'));
  try {
    execFileSync('git', ['worktree', 'add', '--detach', dir, rev], { cwd: REPO_ROOT });
    const deps = join(REPO_ROOT, 'node_modules');
    if (existsSync(deps)) {
      symlinkSync(deps, join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    buildClient(dir);
    await installClient(join(dir, 'dist/client'));
    return await fn();
  } finally {
    try {
      buildClient();
    } finally {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_ROOT });
      } catch {
        // The worktree may never have been added; the directory removal below still cleans up.
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Open a page on `url` that records video at the viewport size, so frames map 1:1 to CSS pixels.
 * Save the recording with `saveVideo`; the webm only exists once the context closes.
 */
export async function newVideoPage(
  browser: Browser,
  url: string,
  { width = 1280, height = 800, colorScheme = 'light', dir }: PageOptions & { dir: string },
) {
  const context = await browser.newContext({
    colorScheme,
    deviceScaleFactor: 1,
    viewport: { width, height },
    recordVideo: { dir, size: { width, height } },
  });
  const page = await context.newPage();
  await page.goto(url);
  await settle(page);
  const video = page.video();
  if (!video) throw new Error('the context did not record a video');
  return { page, context, video };
}

/**
 * Close the recording context and convert the webm to mp4 (GitHub plays mp4 inline, not webm).
 * Needs a system ffmpeg with libx264; Playwright's bundled ffmpeg cannot do this.
 */
export async function saveVideo(
  context: BrowserContext,
  video: { path(): Promise<string> },
  mp4Path: string,
): Promise<string> {
  const webm = await video.path();
  await context.close();
  await mkdir(dirname(mp4Path), { recursive: true });
  execFileSync(
    'ffmpeg',
    ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path],
    { stdio: 'inherit' },
  );
  return mp4Path;
}

/** One video frame at `seconds` as a png. Cheaper than reading whole frames when verifying a take. */
export async function frame(mp4Path: string, seconds: number, pngPath: string): Promise<string> {
  await mkdir(dirname(pngPath), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(seconds), '-i', mp4Path, '-frames:v', '1', pngPath], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return pngPath;
}

/** Duration of a recorded mp4 in seconds, for picking a frame to probe. */
export function videoDuration(mp4Path: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4Path],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
}

/**
 * Screenshot one element. Cropping at capture time keeps the image (and its read-back
 * cost) to the changed surface instead of a full frame.
 */
export async function crop(page: Page, selector: string, path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await page.locator(selector).first().screenshot({ path, animations: 'disabled' });
  return path;
}

/** Screenshot a page region. `box` is in CSS pixels. */
export async function clip(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  path: string,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, clip: box, animations: 'disabled' });
  return path;
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
