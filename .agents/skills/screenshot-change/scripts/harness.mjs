// Screenshot harness for diffle UI changes. Import the helpers from a short scenario
// script instead of re-deriving the browser, server, and shadow-DOM boilerplate.
//
//   import { withDiffle, openBrowser, newPage, seedThreads, crop, selectLines } from
//     '<repo>/.agents/skills/screenshot-change/scripts/harness.mjs';
//
// The diffle-specific selectors (`selectLines`, `openModePicker`) encode where the UI
// lives; the rest is generic.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Diffle checkout that contains this script. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Dist client the server serves. Swap it to screenshot a different client build. */
export const CLIENT_DIR = join(REPO_ROOT, 'dist/client');

/**
 * Extra shared libraries for Chromium. Minimal Linux images lack libnspr4/libnss3 and friends,
 * which live in a package manager prefix; point PLAYWRIGHT_LIBS at its `lib` directory.
 */
function libPath() {
  const dir = process.env.PLAYWRIGHT_LIBS;
  return dir && existsSync(dir) ? dir : null;
}

function resolvePlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href;
  const require = createRequire(join(process.cwd(), 'package.json'));
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return pathToFileURL(require.resolve(name)).href;
    } catch {
      // keep looking
    }
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    for (const name of ['playwright', 'playwright-core']) {
      const candidate = join(globalRoot, name, 'index.mjs');
      if (existsSync(candidate)) return pathToFileURL(candidate).href;
    }
  } catch {
    // npm missing or failed; fall through to the error below
  }
  throw new Error(
    'Playwright not found. Install it once with `npm install --global playwright && playwright install chromium --only-shell`, ' +
      'or point PLAYWRIGHT_MODULE at a playwright `index.mjs`.',
  );
}

/** Launch Chromium with the library path Chromium needs on minimal Linux images. */
export async function openBrowser() {
  const libs = libPath();
  if (libs) process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH ? `${libs}:${process.env.LD_LIBRARY_PATH}` : libs;
  const { chromium } = await import(resolvePlaywright());
  return chromium.launch();
}

/** Open a page on `url` at a desktop viewport, the default screenshot frame. */
export async function newPage(browser, url, { width = 1440, height = 900, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ colorScheme, deviceScaleFactor: 1, viewport: { width, height } });
  const page = await context.newPage();
  await page.goto(url);
  // Diffs load after the container exists; wait for a rendered line so captures are not blank.
  await page.locator('.codeview').waitFor({ timeout: 15000 });
  await page
    .locator('[data-column-number]')
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  return page;
}

/**
 * Start diffle on `repo` for `revs`, with status noise off. Resolves once stderr names the
 * URL. Call `stop` (or use `withDiffle`) to reap the process.
 */
export async function startDiffle({ repo, revs = [], args = [], timeoutMs = 30000 } = {}) {
  const win = process.platform === 'win32';
  const tsx = join(REPO_ROOT, 'node_modules/.bin/tsx') + (win ? '.cmd' : '');
  const proc = spawn(
    tsx,
    ['src/cli/main.ts', '-C', repo, '--port', '0', '--no-open', '--no-watch', '--no-lsp', ...revs, ...args],
    { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' } },
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

/** Install a client build (e.g. the base branch's `dist/client`) into the served directory. */
export async function installClient(sourceDir) {
  await rm(CLIENT_DIR, { recursive: true, force: true });
  await cp(sourceDir, CLIENT_DIR, { recursive: true });
}

/** Build the client in this checkout. Run once per source revision. */
export function buildClient() {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:client'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}

/**
 * Screenshot one element. Cropping at capture time keeps the image (and its read-back
 * cost) to the changed surface instead of a full frame.
 */
export async function crop(page, selector, path) {
  await mkdir(dirname(path), { recursive: true });
  await page.locator(selector).first().screenshot({ path, animations: 'disabled' });
  return path;
}

/** Screenshot a page region. `box` is in CSS pixels: { x, y, width, height }. */
export async function clip(page, box, path) {
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, clip: box, animations: 'disabled' });
  return path;
}

async function cellBox(page, number, side) {
  const cells = page.locator('[data-column-number]');
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
 * Select a line range by dragging the number column, which opens the comment composer.
 * The number cells live in the viewer's shadow DOM; Playwright locators pierce it.
 */
export async function selectLines(page, from, to, side = 'new') {
  await page.locator('[data-column-number]').first().waitFor({ timeout: 15000 });
  const start = await cellBox(page, from, side);
  const end = await cellBox(page, to, side);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height - 4, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
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
