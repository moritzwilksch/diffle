// Record the demo videos: `npm run videos [-- <scene>...]`. A real diffle reviews the demo repository
// from `lib/demo-repo.ts`, driven by Playwright, once per theme. Each scene writes
// `.github/assets/videos/<scene>-<theme>.mp4` and a `.webp` poster (its last frame). The README embeds
// `review-<theme>.gif`, a smaller cut of the same take, since GitHub plays no video stored in the repo.
// diffle.app copies the rest from its `diffle` submodule, along with `prompt.md`, the text `yy`
// copied in the review scene.
//
// Frames are screenshots at 2x device pixels, so text stays sharp; ffmpeg turns them into H.264 (at
// CRF 24 it beat VP9 webm on size). Needs ffmpeg on PATH (with libx264 and libwebp), Docker for
// the browser container (`compose.yml`), and for the review and lsp scenes the pinned pyrefly that
// `PYTHON_LSP` starts (pixi by default). `KEEP_FRAMES=1` keeps the raw frames and a `last.png` and prints where.
import type { Browser, Page } from '@playwright/test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, settle } from '../test/e2e/browser.js';
import { REPO_ROOT, buildClient, buildServer, quiet, waitForLsp, withDiffle } from '../test/e2e/server.js';
import { rmTmp } from '../test/tmp.js';
import { BASE, FEATURE, buildDemoRepo } from './lib/demo-repo.js';

const OUT = join(REPO_ROOT, '.github/assets/videos');
// Pinned, so hover text and reference lists read the same on every machine.
const PYTHON_LSP = process.env.PYTHON_LSP ?? 'pixi exec --spec pyrefly==1.3.2 pyrefly lsp';
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
// Capturing a 2x frame takes longer than a video frame lasts, so each scene plays SLOW times slower
// than written (pauses, typing, CSS animations, the page's timers) and the encode speeds it back up.
const SLOW = Number(process.env.SLOW ?? 3);
const MP4 = { fps: 30, width: 1920 };
// Legible at GitHub's README width, and still about a megabyte.
const GIF = { fps: 15, width: 1280 };

// ---------------------------------------------------------------------------------------------
// Overlays: a pointer and the keys being pressed. Playwright's input is synthetic, so neither would
// appear in the recording otherwise. Both run in the page, so they are self-contained.

function overlays(slow: number) {
  const KEY_NAMES: Record<string, string | null> = {
    Enter: '↵',
    Escape: 'esc',
    ArrowDown: '↓',
    ArrowUp: '↑',
    ' ': 'space',
    Control: null,
    Shift: null,
    Meta: null,
    Alt: null,
  };
  const install = () => {
    const style = document.createElement('style');
    style.textContent = `
      #demo-pointer { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647;
        pointer-events: none; transform: translate(-100px, -100px);
        filter: drop-shadow(0 1px 2px rgb(0 0 0 / .45)); }
      #demo-pointer.down svg { transform: scale(.85); transform-origin: 3px 3px; }
      #demo-keys { position: fixed; left: 20px; bottom: 20px; z-index: 2147483647;
        pointer-events: none; display: flex; gap: 12px; }
      #demo-keys kbd { font: 800 44px/1 ui-monospace, monospace; display: inline-flex; align-items: center;
        justify-content: center; min-width: 60px; height: 60px; padding: 0 16px; border-radius: 14px;
        color: #fff; background: rgb(17 24 39 / .88); border: 1px solid rgb(255 255 255 / .18);
        box-shadow: 0 12px 36px rgb(0 0 0 / .35); transition: opacity .35s ease, transform .35s ease; }
      #demo-keys kbd.gone { opacity: 0; transform: translateY(6px); }
    `;
    document.documentElement.append(style);
    const pointer = document.createElement('div');
    pointer.id = 'demo-pointer';
    pointer.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2.5v17.2l4.7-4.4 3 6.9 3.1-1.3-3-6.8h6.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    const keys = document.createElement('div');
    keys.id = 'demo-keys';
    document.documentElement.append(pointer, keys);

    addEventListener(
      'mousemove',
      (e) => (pointer.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`),
      true,
    );
    addEventListener('mousedown', () => pointer.classList.add('down'), true);
    addEventListener('mouseup', () => pointer.classList.remove('down'), true);

    let last: (HTMLElement & { timer?: ReturnType<typeof setTimeout> }) | null = null;
    let lastAt = 0;
    addEventListener(
      'keydown',
      (e) => {
        const target = e.composedPath()[0];
        const typing =
          target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName));
        const combo = e.ctrlKey || e.metaKey;
        if (typing && !combo && e.key !== 'Escape') return;
        const name = KEY_NAMES[e.key] === undefined ? e.key : KEY_NAMES[e.key];
        if (name === null) return;
        const label = `${e.ctrlKey ? '⌃' : ''}${e.metaKey ? '⌘' : ''}${name}`;
        // Keys pressed in quick succession read as one sequence, like `yy` or `g/`.
        const now = performance.now();
        if (last && now - lastAt < 700 * slow && !last.classList.contains('gone')) last.textContent += ` ${label}`;
        else {
          last = document.createElement('kbd');
          last.textContent = label;
          keys.append(last);
          while (keys.children.length > 3) keys.firstElementChild?.remove();
        }
        lastAt = now;
        const shown = last;
        clearTimeout(shown.timer);
        shown.timer = setTimeout(() => {
          shown.classList.add('gone');
          setTimeout(() => shown.remove(), 400);
        }, 1100);
      },
      true,
    );
  };
  if (document.documentElement) install();
  else addEventListener('DOMContentLoaded', install);
}

/**
 * Stretch the page's timers by `slow`, as the animation playback rate stretches CSS animations, so
 * feedback a timer takes down (a toast, the check mark `yy` puts on the copy button) stays up as long in the
 * video as in diffle.
 */
function slowTimers(slow: number) {
  const setTimeout = window.setTimeout;
  window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) =>
    setTimeout(handler, delay * slow, ...args)) as typeof window.setTimeout;
}

// ---------------------------------------------------------------------------------------------
// Page helpers, paced for a viewer rather than a test.

const pause = (page: Page, ms: number) => page.waitForTimeout(ms * SLOW);

const START = { x: VIEWPORT.width * 0.6, y: VIEWPORT.height * 0.55 };
let pointer = START;
async function glide(page: Page, x: number, y: number, steps = 28) {
  await page.mouse.move(x, y, { steps: steps * SLOW });
  pointer = { x, y };
}

function fileItem(page: Page, path: string) {
  return page
    .locator('diffs-container')
    .filter({ has: page.locator(`[slot="header-custom"] [data-path=${JSON.stringify(path)}]`) })
    .first();
}

/** The file under the cursor; none before the first `J`, unlike the e2e helper's fallback. */
async function activePath(page: Page) {
  const row = page.locator('file-tree-container [data-item-type="file"][aria-selected="true"]').first();
  return (await row.count()) ? row.getAttribute('data-item-path') : null;
}

/** Walk the cursor to `path` with J, the way a reader moves through the review. */
async function walkTo(page: Page, path: string) {
  for (let i = 0; i < 12 && (await activePath(page)) !== path; i++) {
    await page.keyboard.press('J');
    await pause(page, 450);
  }
  if ((await activePath(page)) !== path) throw new Error(`could not walk to ${path}`);
  await pause(page, 400);
}

/** The on-screen number cell of new-side `line` in `path`. */
async function lineCell(page: Page, path: string, line: number) {
  const item = fileItem(page, path);
  await item.locator('[data-column-number]').first().waitFor({ timeout: 15000 });
  const boxes = await item.locator('[data-column-number]').evaluateAll(
    (cells, wanted) =>
      cells
        .filter((c) => c.getAttribute('data-column-number') === wanted)
        .map((c) => c.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0)
        .map(({ x, y, width, height }) => ({ x, y, width, height })),
    String(line),
  );
  // The rightmost cell is the new side's.
  const box = boxes.sort((a, b) => b.x - a.x)[0];
  if (!box) throw new Error(`line ${line} of ${path} is not rendered`);
  return box;
}

/** Drag the number column from `from` to `to`, which opens the composer on that range. */
async function selectLines(page: Page, path: string, from: number, to: number) {
  const start = await lineCell(page, path, from);
  await glide(page, start.x + start.width / 2, start.y + start.height / 2);
  await pause(page, 250);
  await page.mouse.down();
  const end = await lineCell(page, path, to);
  await glide(page, end.x + end.width / 2, end.y + end.height - 4, 14);
  await page.mouse.up();
  await pause(page, 350);
}

async function comment(page: Page, text: string) {
  const composer = page.getByPlaceholder('Leave a comment…');
  await composer.waitFor();
  await pause(page, 300);
  await composer.pressSequentially(text, { delay: 28 * SLOW });
  await pause(page, 500);
  await composer.press('Control+Enter');
  await pause(page, 900);
}

/** The 1-based line of `path` in the demo repository holding `text`. */
function lineOf(repo: string, path: string, text: string) {
  const index = readFileSync(join(repo, path), 'utf8')
    .split('\n')
    .findIndex((line) => line.includes(text));
  if (index === -1) throw new Error(`${path} has no line with ${text}`);
  return index + 1;
}

/**
 * The on-screen box of the first whole-word `word` on the new side of `path`: the right column of a
 * split diff, or the only column of an added file. Measured with a Range over the text, since syntax
 * highlighting can merge a word into a span with its neighbours.
 */
async function wordBox(page: Page, path: string, word: string) {
  const boxes = await fileItem(page, path)
    .locator('span[data-char]')
    .evaluateAll((spans, word) => {
      const pattern = new RegExp(`\\b${word}\\b`);
      const found: { x: number; y: number; width: number; height: number; right: boolean }[] = [];
      for (const span of spans) {
        const text = span.firstChild;
        if (span.childNodes.length !== 1 || !(text instanceof Text)) continue;
        const match = pattern.exec(text.data);
        if (!match) continue;
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + word.length);
        const { x, y, width, height } = range.getBoundingClientRect();
        const container = span.closest('[data-diff]') ?? span.closest('diffs-container');
        const bounds = container?.getBoundingClientRect();
        const middle = bounds ? bounds.x + bounds.width / 2 : 0;
        if (width > 0 && y >= 0 && y + height <= innerHeight) found.push({ x, y, width, height, right: x >= middle });
      }
      return found.sort((a, b) => a.y - b.y);
    }, word);
  const box = boxes.find((b) => b.right) ?? boxes[0];
  if (!box) throw new Error(`${word} is not on screen in ${path}`);
  return box;
}

/** Rest the pointer on `word`; the viewer arms its tooltip on movement inside the token. */
async function hoverWord(page: Page, path: string, word: string) {
  const box = await wordBox(page, path, word);
  await glide(page, box.x + 2, box.y + box.height / 2);
  await glide(page, box.x + Math.min(10, box.width - 2), box.y + box.height / 2, 4);
  return box;
}

/** Hover `word` until its tooltip shows `text`. */
async function hoverUntil(page: Page, path: string, word: string, text: string) {
  const tooltip = page.getByRole('tooltip').filter({ hasText: text });
  // The first hover can land while the server is still opening the document; hover again then.
  for (let attempt = 0; ; attempt++) {
    await hoverWord(page, path, word);
    try {
      await tooltip.waitFor({ timeout: 3000 * SLOW });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await glide(page, pointer.x, pointer.y + 40, 4);
    }
  }
}

/** Step the references list with j until line `line` of `path` is highlighted. */
async function stepToReference(page: Page, path: string, line: number) {
  const active = () =>
    page.locator('[data-active="true"]').evaluate((row) => ({
      path: row.closest('section')?.querySelector('header')?.textContent ?? '',
      line: Number(row.firstElementChild?.textContent),
    }));
  for (let i = 0; i < 12; i++) {
    const at = await active();
    if (at.path.includes(path) && at.line === line) return;
    await page.keyboard.press('j');
    await pause(page, 700);
  }
  throw new Error(`no reference at ${path}:${line}`);
}

/** Click a button in the symbol menu, e.g. "Go to definition". */
async function pickFromSymbolMenu(page: Page, title: string) {
  const button = page.locator(`[data-symbol-menu] [title^="${title}"]`);
  await button.waitFor();
  await pause(page, 500);
  const box = await button.boundingBox();
  if (!box) throw new Error(`${title} is not on screen`);
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, 16);
  await pause(page, 250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// ---------------------------------------------------------------------------------------------
// Scenes. Each gets a fresh repository and a fresh diffle, so no review state carries over.

interface Scene {
  play(page: Page, demo: { url: string; repo: string }): Promise<void>;
  /** Further diffle flags; no language server unless the scene shows one. */
  args?: string[];
  /** Unified leaves the comment composer room; the rest use split. */
  unified?: boolean;
  /** Also cut a README GIF from the take. */
  gif?: boolean;
}

const SCENES: Record<string, Scene> = {
  /**
   * The core loop with a language server: hover a call, find its references, jump to one, comment on
   * it, and copy every comment as one prompt.
   */
  review: {
    args: ['--lsp', `python=${PYTHON_LSP}`],
    unified: true,
    gif: true,
    async play(page, { url, repo }) {
      await pause(page, 1000);
      await walkTo(page, 'shortlink/app.py');
      await hoverUntil(page, 'shortlink/app.py', 'allow', 'Spend one token');
      await pause(page, 2400);

      const call = await wordBox(page, 'shortlink/app.py', 'allow');
      await page.mouse.click(call.x + 6, call.y + call.height / 2);
      await pickFromSymbolMenu(page, 'Find references');
      await page.getByRole('dialog').waitFor();
      await pause(page, 1200);
      const test = 'tests/test_ratelimit.py';
      const refill = lineOf(repo, test, 'now[0] += 0.5');
      await stepToReference(page, test, refill + 1);
      await pause(page, 600);
      await page.keyboard.press('Enter');
      await pause(page, 1500);

      await selectLines(page, test, refill, refill + 1);
      await comment(
        page,
        'Also step the clock back: a negative `elapsed` drains the bucket. `time.monotonic()` cannot go back.',
      );

      await glide(page, VIEWPORT.width * 0.55, VIEWPORT.height * 0.3);
      await pause(page, 500);
      await page.keyboard.press('y');
      await pause(page, 90);
      await page.keyboard.press('y');
      // End while the copy-all button still shows its check mark, so the poster shows the copy landed.
      await pause(page, 1000);

      const prompt = await (await fetch(new URL('api/threads/export?state=open', url))).text();
      writeFileSync(join(OUT, 'prompt.md'), prompt);
    },
  },

  /** Keyboard-first reading: lines, hunks, files, viewed marks, the range's commits, the file filter. */
  navigate: {
    async play(page) {
      await pause(page, 1000);
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('j');
        await pause(page, 170);
      }
      await pause(page, 300);
      await page.keyboard.press('v');
      await pause(page, 1200);
      for (const key of [']', ']', ']']) {
        await page.keyboard.press(key);
        await pause(page, 700);
      }
      await page.keyboard.press('K');
      await pause(page, 900);
      await page.keyboard.press('J');
      await pause(page, 900);
      // Step from the whole range through each commit, oldest last, then back up to all changes.
      for (const key of ['<', '<', '<', '>', '>', '>']) {
        await page.keyboard.press(key);
        await pause(page, 1000);
      }
      await page.keyboard.press('g');
      await pause(page, 80);
      await page.keyboard.press('f');
      await pause(page, 400);
      await page.keyboard.type('test', { delay: 120 * SLOW });
      await pause(page, 900);
      await page.keyboard.press('Enter');
      await pause(page, 1500);
      await page.keyboard.press('?');
      await pause(page, 2600);
    },
  },

  /** Language-server hover, go to definition, and references, served by a pinned pyrefly. */
  lsp: {
    args: ['--lsp', `python=${PYTHON_LSP}`],
    async play(page) {
      await pause(page, 900);
      await hoverUntil(page, 'shortlink/app.py', 'allow', 'Spend one token');
      await pause(page, 2600);

      const call = await wordBox(page, 'shortlink/app.py', 'allow');
      await page.mouse.click(call.x + 6, call.y + call.height / 2);
      await pickFromSymbolMenu(page, 'Go to definition');
      for (let i = 0; i < 50 && (await activePath(page)) !== 'shortlink/ratelimit.py'; i++) await pause(page, 50);
      await pause(page, 1500);

      const definition = await hoverWord(page, 'shortlink/ratelimit.py', 'allow');
      await pause(page, 500);
      await page.mouse.click(definition.x + 6, definition.y + definition.height / 2);
      await pickFromSymbolMenu(page, 'Find references');
      await pause(page, 1800);
      // Peek at the highlighted reference, walk the list down to a call in the tests, and jump there.
      await page.keyboard.press(' ');
      // The hint gains `J K scroll` once the peek is open.
      await page.getByRole('dialog').getByText('scroll').waitFor();
      await pause(page, 1600);
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('j');
        await pause(page, 900);
      }
      await pause(page, 600);
      await page.keyboard.press('Enter');
      await pause(page, 2200);
    },
  },

  /** Search across every changed file. */
  search: {
    async play(page) {
      await pause(page, 1000);
      await page.keyboard.press('g');
      await pause(page, 80);
      await page.keyboard.press('/');
      await pause(page, 500);
      await page.keyboard.type('limiter', { delay: 110 * SLOW });
      await pause(page, 400);
      await page.keyboard.press('Enter');
      await pause(page, 1100);
      // Step past the matches in app.py into the limiter itself and its tests.
      for (const wait of [500, 500, 500, 500, 500, 900, 900, 900, 1100]) {
        await page.keyboard.press('n');
        await pause(page, wait);
      }
      await pause(page, 800);
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Recording

/** A captured screenshot, and when it was taken in the scene's own (unslowed) seconds. */
interface Frame {
  file: string;
  at: number;
}

/**
 * Capture screenshots back to back until stopped. Chromium's screencast caps frames at CSS pixels;
 * Playwright's screenshot honours the device scale factor.
 */
function capture(page: Page, dir: string): () => Promise<Frame[]> {
  const frames: Frame[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
      const sent = performance.now();
      await page.screenshot({ path: file, type: 'jpeg', quality: 92, caret: 'initial' });
      frames.push({ file, at: (sent + performance.now()) / 2000 / SLOW });
    }
  })();
  return async () => {
    running = false;
    await loop;
    return frames;
  };
}

/**
 * Encode frames, each shown until the next one arrived and the last held, as `<name>.mp4` with its
 * last frame as a `<name>.webp` poster, and with `gif` also as `<name>.gif`.
 */
function encode(frames: Frame[], dir: string, name: string, gif: boolean, hold = 1.5) {
  if (frames.length < 2) throw new Error(`${name}: only ${frames.length} frames captured`);
  const lines = frames.flatMap((frame, i) => {
    const next = frames[i + 1];
    return [`file '${frame.file}'`, `duration ${Math.max(next ? next.at - frame.at : hold, 1 / MP4.fps).toFixed(4)}`];
  });
  // The concat demuxer ignores the last entry's duration unless the file is repeated.
  const last = frames.at(-1)!.file;
  lines.push(`file '${last}'`);
  const list = join(dir, 'frames.txt');
  writeFileSync(list, lines.join('\n'));
  const input = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list];

  const mp4 = join(OUT, `${name}.mp4`);
  const poster = join(OUT, `${name}.webp`);
  quiet('ffmpeg', [
    ...input,
    '-vf',
    `fps=${MP4.fps},scale=${MP4.width}:-2:flags=lanczos`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    mp4,
  ]);
  quiet('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    last,
    '-vf',
    `scale=${MP4.width}:-2:flags=lanczos`,
    '-c:v',
    'libwebp',
    '-quality',
    '80',
    poster,
  ]);
  const outputs = [mp4, poster];
  if (gif) {
    const file = join(OUT, `${name}.gif`);
    // One palette for the whole take, and only changed pixels per frame: the UI is mostly still.
    quiet('ffmpeg', [
      ...input,
      '-vf',
      `fps=${GIF.fps},scale=${GIF.width}:-2:flags=lanczos,split[a][b];` +
        '[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      file,
    ]);
    outputs.push(file);
  }
  for (const file of outputs)
    console.log(`${file.slice(REPO_ROOT.length + 1)} ${(statSync(file).size / 1e6).toFixed(1)} MB`);
}

async function record(browser: Browser, name: string, theme: 'dark' | 'light') {
  const scene = SCENES[name]!;
  const work = await mkdtemp(join(tmpdir(), `diffle-video-${name}-${theme}-`));
  const repo = join(work, 'shortlink');
  buildDemoRepo(repo);
  try {
    await withDiffle({ repo, revs: [`${BASE}...${FEATURE}`], args: scene.args }, async ({ url }) => {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: SCALE,
        colorScheme: theme,
        locale: 'en-US',
        timezoneId: 'UTC',
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      try {
        // tsx wraps named functions in `__name(...)`, which the page lacks when they are serialized into it.
        await context.addInitScript({ content: 'globalThis.__name = (fn) => fn;' });
        await context.addInitScript(slowTimers, SLOW);
        await context.addInitScript(overlays, SLOW);
        if (scene.unified) await context.addInitScript(() => localStorage.setItem('diffle:diffStyle', 'unified'));
        const page = await context.newPage();
        await page.goto(url);
        await settle(page);
        if (scene.args?.includes('--lsp')) await waitForLsp(url, 120000);
        await pause(page, 500);
        pointer = START;
        await page.mouse.move(pointer.x, pointer.y);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Animation.enable');
        await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });

        const dir = join(work, 'frames');
        mkdirSync(dir);
        const stop = capture(page, dir);
        let frames: Frame[];
        try {
          await scene.play(page, { url, repo });
        } finally {
          frames = await stop();
          if (process.env.KEEP_FRAMES) await page.screenshot({ path: join(work, 'last.png') });
        }
        encode(frames, dir, `${name}-${theme}`, scene.gif ?? false);
      } finally {
        await context.close();
      }
    });
  } finally {
    if (process.env.KEEP_FRAMES) console.log(`${name}-${theme}: frames kept in ${work}`);
    else await rmTmp(work);
  }
}

const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!(name in SCENES)) {
    console.error(`unknown scene ${name}; have ${Object.keys(SCENES).join(', ')}`);
    process.exit(2);
  }
}
buildClient();
buildServer();
mkdirSync(OUT, { recursive: true });
const browser = await openBrowser();
try {
  for (const name of wanted.length ? wanted : Object.keys(SCENES)) {
    for (const theme of ['dark', 'light'] as const) await record(browser, name, theme);
  }
} finally {
  await browser.close();
}
