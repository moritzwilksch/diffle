import type { Browser, BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLIENT_DIR, REPO_ROOT, buildClient } from './server.js';
import { settle, type PageOptions } from './browser.js';

/** Install a client build (e.g. the base branch's `dist/client`) into the served directory. */
export async function installClient(sourceDir: string): Promise<void> {
  await rm(CLIENT_DIR, { recursive: true, force: true });
  await cp(sourceDir, CLIENT_DIR, { recursive: true });
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
