// Screenshot harness for diffle UI changes. `shoot.mjs` runs a scenario over it; a custom script can
// import the helpers directly by absolute path.
//
// The diffle verbs (`header`, `viewed`, `collapsed`, `setViewed`, `toggleCollapse`, `activePath`,
// `gotoFile`, `selectLines`, `openModePicker`, `filePaths`) encode where the UI lives; the rest is
// generic. Verbs that take a path index files by tree order; `filePaths` returns that order.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Skill directory that contains this script. */
export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Diffle checkout that contains this script. */
export const REPO_ROOT = resolve(SKILL_ROOT, '../../..');

const win = process.platform === 'win32';
const npm = win ? 'npm.cmd' : 'npm';

/**
 * Chromium's shared libraries. A headless shell needs libnspr4/libnss3 and friends, which a
 * minimal Linux image lacks. `PLAYWRIGHT_LIBS` overrides; otherwise a local pixi env that
 * provides them is used when present.
 */
function libPath() {
  const explicit = process.env.PLAYWRIGHT_LIBS;
  if (explicit && existsSync(explicit)) return explicit;
  const fallback = join(homedir(), '.pixi/envs/chromelibs/lib');
  return existsSync(join(fallback, 'libnspr4.so')) ? fallback : null;
}

function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href;
  // The skill's own install first, so the app's dependencies stay out of it; then the checkout, for
  // a machine that installed it there; then cwd, for a scenario that carries its own; then global.
  for (const from of [SKILL_ROOT, REPO_ROOT, process.cwd()]) {
    const require = createRequire(join(from, 'package.json'));
    for (const name of ['playwright', 'playwright-core']) {
      try {
        return pathToFileURL(require.resolve(name)).href;
      } catch {
        // keep looking
      }
    }
  }
  try {
    const globalRoot = execFileSync(npm, ['root', '-g'], { encoding: 'utf8' }).trim();
    for (const name of ['playwright', 'playwright-core']) {
      const candidate = join(globalRoot, name, 'index.mjs');
      if (existsSync(candidate)) return pathToFileURL(candidate).href;
    }
  } catch {
    // npm missing or failed; fall through to the error below
  }
  throw new Error('Playwright not found; see SETUP.md.');
}

/** Launch Chromium, adding Chromium's shared libraries to the loader path when found. */
export async function openBrowser() {
  const libs = libPath();
  if (libs) process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH ? `${libs}:${process.env.LD_LIBRARY_PATH}` : libs;
  // The local `playwright` resolves to its CommonJS entry, whose exports land under `default`.
  const mod = await import(resolvePlaywright());
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error(`Playwright at ${resolvePlaywright()} exposes no chromium export`);
  return chromium.launch();
}

/** Run a command with its output captured; on failure, throw with the output's tail. */
function quiet(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed\n${out}`);
  }
}

/** Inputs of the client build; a change to any of them makes `dist/client` stale. */
const CLIENT_INPUTS = ['src/client', 'src/shared', 'vite.config.ts', 'tsconfig.client.json', 'package-lock.json'];

function inputsKey(root) {
  const hash = createHash('sha256');
  const walk = (path) => {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (!st.isDirectory()) return hash.update(`${relative(root, path)}\0${st.size}\0${st.mtimeMs}\n`);
    for (const name of readdirSync(path).sort()) walk(join(path, name));
  };
  for (const input of CLIENT_INPUTS) walk(join(root, input));
  return hash.digest('hex');
}

/**
 * Build `root`'s client unless `dist/client` already matches its sources. Output is captured and
 * shown only on failure. Returns whether it built.
 */
export function buildClient(root = REPO_ROOT) {
  const stamp = join(root, 'dist/client/.shoot-stamp');
  const key = inputsKey(root);
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === key) return false;
  quiet(npm, ['run', 'build:client'], { cwd: root });
  writeFileSync(stamp, key);
  return true;
}

/**
 * A built checkout of `rev`, for the before state: `git archive` into a cache keyed by commit, with
 * this checkout's `node_modules` linked in. Built once per commit and never registered as a
 * worktree, so re-runs are instant and `git worktree list` stays clean.
 */
export function baseCheckout(rev) {
  const sha = quiet('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', `${rev}^{commit}`]).trim();
  const cache = join(tmpdir(), 'diffle-shoot-base');
  const dir = join(cache, sha);
  if (existsSync(join(dir, 'dist/client/index.html'))) return dir;
  const staging = `${dir}.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const tar = `${staging}.tar`;
  quiet('git', ['-C', REPO_ROOT, 'archive', '-o', tar, sha]);
  quiet('tar', ['-xf', tar, '-C', staging]);
  rmSync(tar, { force: true });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(staging, 'node_modules'), win ? 'junction' : 'dir');
  buildClient(staging);
  try {
    renameSync(staging, dir);
  } catch {
    // A parallel run built the same commit first; use its copy.
    rmSync(staging, { recursive: true, force: true });
  }
  return dir;
}

const GIT_ID = ['-c', 'user.name=diffle-demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false'];

async function writeTree(repo, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(repo, path);
    if (text === null) await rm(file, { force: true });
    else {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
  }
}

/**
 * A throwaway repo in the system temp dir: `before` committed, then `after` (a path to text, or
 * `null` to delete) committed on top, or left in the worktree when `commit` is false. Git runs with
 * an explicit `-C` and inline identity, so nothing touches this checkout or its config.
 */
export async function demoRepo({ before = {}, after = {}, commit = true }) {
  const repo = await mkdtemp(join(tmpdir(), 'diffle-demo-'));
  const git = (...args) => quiet('git', ['-C', repo, ...GIT_ID, ...args]);
  git('init', '-q', '-b', 'main');
  await writeTree(repo, before);
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'before');
  await writeTree(repo, after);
  if (commit) {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'after');
  }
  return repo;
}

/** Wait until the viewer has rendered a line, so captures are not blank. */
export async function waitForViewer(page) {
  await page.locator('.codeview').waitFor({ timeout: 15000 });
  await page
    .locator('[data-column-number]')
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
}

/**
 * Open a page on `url` at a desktop viewport, the default screenshot frame. `scale` is the capture
 * DPR: 2 by default so glyphs rasterize at 2x and a crop stays crisp on a HiDPI display. It only
 * changes `crop`/`clip` output size; Playwright boxes and mouse coordinates stay in CSS pixels.
 */
export async function newPage(browser, url, { width = 1440, height = 900, colorScheme = 'light', scale = 2 } = {}) {
  const context = await browser.newContext({ colorScheme, deviceScaleFactor: scale, viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await waitForViewer(page);
  return page;
}

/**
 * Start diffle from checkout `root` on `repo` for `revs`, with status noise off. Resolves once
 * stderr names the URL. Call `stop` (or use `withDiffle`) to reap the process.
 */
export async function startDiffle({ repo, revs = [], args = [], root = REPO_ROOT, timeoutMs = 30000 } = {}) {
  const tsx = join(REPO_ROOT, 'node_modules/.bin/tsx') + (win ? '.cmd' : '');
  const proc = spawn(
    tsx,
    ['src/cli/main.ts', '-C', repo, '--port', '0', '--no-open', '--no-watch', '--no-lsp', ...revs, ...args],
    { cwd: root, env: { ...process.env, NO_COLOR: '1' } },
  );
  let stderr = '';
  let stdout = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`diffle did not start in ${timeoutMs}ms\n${stderr}`)), timeoutMs);
    const scan = () => {
      const match = stderr.match(/diffle running at (\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolveUrl(match[1]);
    };
    proc.stderr.on('data', scan);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`diffle exited (${code})\n${stderr}\n${stdout}`));
    });
    scan();
  }).catch((error) => {
    proc.kill('SIGKILL');
    throw error;
  });

  return {
    url,
    proc,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((done) => {
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
export async function withDiffle(opts, fn) {
  const server = await startDiffle(opts);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

/** Create threads directly: everything the sidebar shows is HTTP state, not UI state. */
export async function seedThreads(url, threads) {
  const response = await fetch(new URL('api/threads', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(threads),
  });
  if (!response.ok) throw new Error(`seeding threads failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

/** Threads as the client sees them, for asserting that a comment landed where the script meant it to. */
export async function readThreads(url) {
  const response = await fetch(new URL('api/threads', url));
  if (!response.ok) throw new Error(`reading threads failed: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

/**
 * Delete the review state (viewed, collapsed, threads) that diffle keeps under `<git-dir>/diffle/`.
 * Call before a take: a stale viewed or collapsed flag silently changes what the recording shows.
 */
export function resetReviewState(repo) {
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repo, encoding: 'utf8' }).trim();
  rmSync(join(resolve(repo, gitDir), 'diffle'), { recursive: true, force: true });
}

/**
 * Open a page on `url` that records video at the viewport size, so frames map 1:1 to CSS pixels.
 * Save the recording with `saveVideo`; the webm only exists once the context closes.
 */
export async function newVideoPage(browser, url, { width = 1280, height = 800, colorScheme = 'light', dir } = {}) {
  if (!dir) throw new Error('newVideoPage needs a `dir` for the video files');
  const context = await browser.newContext({
    colorScheme,
    deviceScaleFactor: 1,
    viewport: { width, height },
    recordVideo: { dir, size: { width, height } },
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await waitForViewer(page);
  return { page, context, video: page.video() };
}

/**
 * Close the recording context and convert the webm to mp4 (GitHub plays mp4 inline, not webm),
 * then drop the webm. Needs a system ffmpeg with libx264; Playwright's bundled ffmpeg lacks it.
 */
export async function saveVideo(context, video, mp4Path) {
  const webm = await video.path();
  await context.close();
  await mkdir(dirname(mp4Path), { recursive: true });
  quiet('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    webm,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    mp4Path,
  ]);
  rmSync(webm, { force: true });
  return mp4Path;
}

/** One video frame at `seconds` as a png. Cheaper than reading whole frames when verifying a take. */
export async function frame(mp4Path, seconds, pngPath) {
  await mkdir(dirname(pngPath), { recursive: true });
  quiet('ffmpeg', ['-y', '-v', 'error', '-ss', String(seconds), '-i', mp4Path, '-frames:v', '1', pngPath]);
  return pngPath;
}

/** Duration of a recorded mp4 in seconds, for picking a frame to probe. */
export function videoDuration(mp4Path) {
  return Number(
    quiet('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4Path]).trim(),
  );
}

/**
 * Screenshot one element: a selector or a Playwright locator. Cropping at capture time keeps the
 * image (and its read-back cost) to the changed surface instead of a full frame.
 */
export async function crop(page, target, path) {
  await mkdir(dirname(path), { recursive: true });
  const locator = typeof target === 'string' ? page.locator(target) : target;
  await locator.first().screenshot({ path, animations: 'disabled' });
  return path;
}

/** Screenshot a page region. `box` is in CSS pixels: { x, y, width, height }. */
export async function clip(page, box, path) {
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, clip: box, animations: 'disabled' });
  return path;
}

/** Width and height of a png, read from its header. */
export function pngSize(path) {
  const header = readFileSync(path).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

/**
 * Before and after pngs side by side (stacked when wide), labelled, in one image at 1x: one read
 * verifies a change. `scale` is the crops' DPR, so they render at their CSS size.
 */
export async function compare(browser, { before, after, out, labels = ['Before', 'After'], scale = 2 }) {
  const img = async (path) => `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
  const width = Math.max(pngSize(before).width, pngSize(after).width) / scale;
  const row = width <= 700;
  const cell = async (label, path) =>
    `<figure><figcaption>${label}</figcaption><img src="${await img(path)}" style="width:${pngSize(path).width / scale}px"></figure>`;
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 100, height: 100 } });
  try {
    const page = await context.newPage();
    await page.setContent(
      `<style>body{margin:0;font:600 13px system-ui;background:#fff}main{display:inline-flex;flex-direction:${row ? 'row' : 'column'};gap:12px;padding:12px}figure{margin:0}figcaption{margin-bottom:4px;color:#555}img{display:block;outline:1px solid #ddd}</style>` +
        `<main>${await cell(labels[0], before)}${await cell(labels[1], after)}</main>`,
    );
    await mkdir(dirname(out), { recursive: true });
    await page.locator('main').screenshot({ path: out });
  } finally {
    await context.close();
  }
  return out;
}

/** Changed files in the order the diff renders them, the order the verbs below index by. */
export async function filePaths(page) {
  const rows = page.locator('file-tree-container [data-item-type="file"]');
  const count = await rows.count();
  const paths = [];
  for (let i = 0; i < count; i++) paths.push(await rows.nth(i).getAttribute('data-item-path'));
  return paths;
}

/**
 * The rendered file, a `diffs-container` holding the header and the viewed and collapse controls.
 * Found by the path in diffle's slotted header, whose path span carries the full path as its title,
 * not by position, so a file the viewer skips does not shift the mapping for the ones after it.
 */
async function fileItem(page, path) {
  const paths = await filePaths(page);
  if (!paths.includes(path))
    throw new Error(`not a changed file: ${path} (tree has ${paths.join(', ') || 'no files'})`);
  // The app's tooltip lifts `title` off the hovered control, which the path and button lookups
  // match on; parking the pointer closes the tip and restores the attribute.
  await page.mouse.move(0, 0);
  const item = page
    .locator('diffs-container')
    .filter({ has: page.locator(`[slot="header-custom"] [title=${JSON.stringify(path)}]`) })
    .first();
  await item.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {
    throw new Error(
      `no rendered file for ${path}: the tree lists it, but no diffs-container has a header titled with it. ` +
        'If FileHeader markup changed, update fileItem in harness.mjs and run scripts/selftest.mjs.',
    );
  });
  return item;
}

/** A control inside a file's header or body, with an error that names what was missing. */
async function control(page, path, selector) {
  const locator = (await fileItem(page, path)).locator(selector);
  if ((await locator.count()) === 0) {
    throw new Error(
      `${path} has no ${selector}; if the header controls changed, update harness.mjs and run scripts/selftest.mjs.`,
    );
  }
  return locator.first();
}

/** The file header, for scrolling to or clicking. */
export async function header(page, path) {
  return (await fileItem(page, path)).locator('[data-diffs-header]');
}

/** Whether the file is marked viewed. */
export async function viewed(page, path) {
  return (await control(page, path, 'input[type="checkbox"]')).isChecked();
}

/**
 * The file the cursor is in, read from the tree's selected row. Before the first navigation nothing
 * is selected, so this falls back to the first changed file, the cursor's default home. Reading the
 * tree rather than the viewer means it also reports files with no diff container (binary, oversized).
 */
export async function activePath(page) {
  const row = page.locator('file-tree-container [data-item-type="file"][aria-selected="true"]').first();
  if (await row.count()) return row.getAttribute('data-item-path');
  return (await filePaths(page))[0] ?? null;
}

/**
 * Move the cursor to `path` by clicking its file-tree row: the app selects the file, expands it if
 * collapsed, and hands focus to the review pane. Deterministic where counting `J` presses is not.
 * Needs the tree visible (`Ctrl+B` toggles it); a hidden tree has no row to click.
 */
export async function gotoFile(page, path) {
  const row = page.locator(`file-tree-container [data-item-type="file"][data-item-path=${JSON.stringify(path)}]`);
  if ((await row.count()) === 0) throw new Error(`not a changed file: ${path}`);
  await row.first().click();
  for (let i = 0; i < 50; i++) {
    if ((await activePath(page)) === path) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`did not move the cursor to ${path}`);
}

/** Whether the file's diff is collapsed. A collapsed file renders no line-number rows. */
export async function collapsed(page, path) {
  return (await (await fileItem(page, path)).locator('[data-column-number]').count()) === 0;
}

/**
 * Mark the file viewed or unviewed, the same toggle the header label drives. Viewing also collapses
 * the file and moves the cursor to the next unviewed file. Blurs the checkbox afterwards: it is an
 * `INPUT`, and the keymap ignores keys while one has focus, so a later `J`/`v` would silently no-op.
 */
export async function setViewed(page, path, on) {
  const box = await control(page, path, 'input[type="checkbox"]');
  if ((await box.isChecked()) !== on) {
    await box.click();
    await box.blur();
  }
}

/** Collapse or expand the file's diff. Moves the cursor, like a header click. */
export async function toggleCollapse(page, path) {
  await (await control(page, path, 'button[title="Collapse / expand"]')).click();
}

async function cellBox(root, number, side) {
  const cells = root.locator('[data-column-number]');
  const wantRight = side !== 'old';
  let best = null;
  for (let i = 0; i < (await cells.count()); i++) {
    const cell = cells.nth(i);
    if ((await cell.getAttribute('data-column-number')) !== String(number)) continue;
    const box = await cell.boundingBox();
    if (!box) continue;
    if (best === null || (wantRight ? box.x > best.x : box.x < best.x)) best = box;
  }
  if (!best) throw new Error(`line ${number} not found on the ${side} side`);
  return best;
}

/**
 * Select `path`'s line range by dragging its number column, which opens the comment composer.
 * `path` scopes the drag: line numbers repeat across files, and an unscoped search picks the
 * first file that has the line rather than the one the cursor is in. The number cells live in the
 * viewer's shadow DOM; Playwright locators pierce it.
 */
export async function selectLines(page, path, from, to = from, side = 'new') {
  // A press on an already-selected line toggles it off, and navigation leaves the cursor's line
  // selected; Escape clears it so the drag always opens the composer.
  await page.keyboard.press('Escape');
  const root = await fileItem(page, path);
  await root.locator('[data-column-number]').first().waitFor({ timeout: 15000 });
  const start = await cellBox(root, from, side);
  const end = await cellBox(root, to, side);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height - 4, { steps: 8 });
  await page.mouse.up();
  await page.locator('textarea').first().waitFor({ timeout: 5000 });
}

/** Open the compare menu and pick an entry ("Working", "Two refs", "Last commits", "PR"). */
export async function openModePicker(page, entry) {
  await page.getByTitle(/Change what is compared/).click();
  const menu = page.locator('#mode-picker');
  await menu.waitFor();
  if (entry) await menu.locator('button', { hasText: entry }).first().click();
  await page.waitForTimeout(300);
  return menu;
}
