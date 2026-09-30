import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, buildClient, quiet } from './server.js';
import { settle, type PageOptions } from './browser.js';

/**
 * A built copy of `rev`, for the before state: pass it as `startDiffle({ root })` to run that
 * revision's server and client. `git archive` fills a cache keyed by commit, linked to this
 * checkout's `node_modules`; it is built once per commit and never registered as a worktree.
 */
export function baseCheckout(rev: string): string {
  const sha = quiet('git', ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
  const dir = join(tmpdir(), 'diffle-base', sha);
  if (existsSync(join(dir, 'dist/client/index.html'))) return dir;
  const staging = `${dir}.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  quiet('git', ['archive', '-o', `${staging}.tar`, sha]);
  quiet('tar', ['-xf', `${staging}.tar`, '-C', staging]);
  rmSync(`${staging}.tar`, { force: true });
  symlinkSync(
    join(REPO_ROOT, 'node_modules'),
    join(staging, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  buildClient(staging);
  try {
    renameSync(staging, dir);
  } catch {
    // A parallel run built the same commit first; use its copy.
    rmSync(staging, { recursive: true, force: true });
  }
  return dir;
}

/** Paths mapped to their text, or to `null` to delete them. */
export type DemoFiles = Record<string, string | null>;

export interface DemoRepoSpec {
  before?: DemoFiles;
  after?: DemoFiles;
  /** Commit `after` on top of `before` (the default), or leave it in the worktree. */
  commit?: boolean;
}

const GIT_ID = ['-c', 'user.name=diffle-demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false'];

async function writeFiles(repo: string, files: DemoFiles): Promise<void> {
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
 * A throwaway repo in the temp dir for a diff the fixture lacks. Git runs with `-C` and an inline
 * identity, so nothing touches this checkout or its config.
 */
export async function demoRepo({ before = {}, after = {}, commit = true }: DemoRepoSpec): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'diffle-demo-'));
  const git = (...args: string[]) => quiet('git', ['-C', repo, ...GIT_ID, ...args]);
  git('init', '-q', '-b', 'main');
  await writeFiles(repo, before);
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'before');
  await writeFiles(repo, after);
  if (commit) {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'after');
  }
  return repo;
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
 * Close the recording context, convert the webm to mp4 (GitHub plays mp4 inline, not webm), and
 * drop the webm. Needs a system ffmpeg with libx264; Playwright's bundled ffmpeg lacks it.
 */
export async function saveVideo(
  context: BrowserContext,
  video: { path(): Promise<string> },
  mp4Path: string,
): Promise<string> {
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
export async function frame(mp4Path: string, seconds: number, pngPath: string): Promise<string> {
  await mkdir(dirname(pngPath), { recursive: true });
  quiet('ffmpeg', ['-y', '-v', 'error', '-ss', String(seconds), '-i', mp4Path, '-frames:v', '1', pngPath]);
  return pngPath;
}

/** Duration of a recorded mp4 in seconds, for picking a frame to probe. */
export function videoDuration(mp4Path: string): number {
  const out = quiet('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    mp4Path,
  ]);
  return Number(out.trim());
}

/**
 * Screenshot one element, by selector or locator. Cropping at capture time keeps the image (and
 * its read-back cost) to the changed surface instead of a full frame.
 */
export async function crop(page: Page, target: string | Locator, path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const locator = typeof target === 'string' ? page.locator(target) : target;
  await locator.first().screenshot({ path, animations: 'disabled' });
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

/** Width and height of a png, read from its header. */
export function pngSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

/**
 * Before and after pngs side by side (stacked when wide), labelled, in one 1x image, so one read
 * verifies a change. `scale` is the crops' DPR; they render at their CSS size.
 */
export async function compare(
  browser: Browser,
  {
    before,
    after,
    out,
    labels = ['Before', 'After'],
    scale = 2,
  }: { before: string; after: string; out: string; labels?: [string, string]; scale?: number },
): Promise<string> {
  const cell = async (label: string, path: string) => {
    const data = (await readFile(path)).toString('base64');
    return `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${data}" style="width:${pngSize(path).width / scale}px"></figure>`;
  };
  const row = Math.max(pngSize(before).width, pngSize(after).width) / scale <= 700;
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
