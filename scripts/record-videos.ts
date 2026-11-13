// Record the demo videos: `npm run videos [-- <scene>...]`. A real diffle reviews the demo repository
// from `lib/demo-repo.ts`, driven by Playwright, once per theme. Each scene (`lib/video/scenes.ts`)
// writes `.github/assets/videos/<scene>-<theme>.mp4` and a `.webp` poster (its last frame). The README
// embeds `review-<theme>.gif`, `tour-<theme>.gif` and `graph-<theme>.gif`, smaller cuts of the same
// takes, since GitHub plays no video stored in the repo.
// diffle.app copies the rest from its `diffle` submodule, along with `prompt.md`, the text `yy`
// copied in the review scene.
//
// Frames are screenshots at 2x device pixels, so text stays sharp; ffmpeg turns them into H.264 (at
// CRF 24 it beat VP9 webm on size). Needs ffmpeg on PATH (with libx264 and libwebp), Docker for
// the browser container (`compose.yml`), and for the scenes with a language server the pinned pyrefly
// that `PYTHON_LSP` starts (pixi by default). `KEEP_FRAMES=1` keeps the raw frames and a `last.png` and prints where.
import type { Browser } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, settle } from '../test/e2e/browser.js';
import { buildClient, buildServer, waitForLsp, withDiffle } from '../test/e2e/server.js';
import { rmTmp } from '../test/tmp.js';
import { BASE, FEATURE, buildDemoRepo } from './lib/demo-repo.js';
import { OUT, capture, encode, type Frame } from './lib/video/encode.js';
import { overlays, slowTimers } from './lib/video/overlays.js';
import { SLOW, VIEWPORT, homePointer, pause } from './lib/video/pace.js';
import { SCENES } from './lib/video/scenes.js';

const SCALE = 2;

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
        await homePointer(page);
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
