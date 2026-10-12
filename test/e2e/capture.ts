import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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
 * Close the recording context and re-encode Playwright's VP8 webm as VP9 webm at `webmPath`.
 * VP9 at CRF 40 keeps UI text legible at about half the bytes of H.264. Needs a system ffmpeg
 * with libvpx-vp9; Playwright's bundled ffmpeg lacks it.
 */
export async function saveVideo(
  context: BrowserContext,
  video: { path(): Promise<string> },
  webmPath: string,
): Promise<string> {
  const recorded = await video.path();
  await context.close();
  await mkdir(dirname(webmPath), { recursive: true });
  quiet('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    recorded,
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '40',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    webmPath,
  ]);
  rmSync(recorded, { force: true });
  return webmPath;
}

/** Duration of a video in seconds. */
export function videoDuration(path: string): number {
  const out = quiet('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]);
  return Number(out.trim());
}

/**
 * Screenshot one element, by selector or locator. Cropping at capture time keeps the image (and
 * its read-back cost) to the changed surface instead of a full frame.
 */
export async function crop(page: Page, target: string | Locator, path: string): Promise<string> {
  const locator = typeof target === 'string' ? page.locator(target) : target;
  await writeWebp(await locator.first().screenshot({ animations: 'disabled' }), path);
  return path;
}

/** Screenshot a page region. `box` is in CSS pixels. */
export async function clip(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  path: string,
): Promise<string> {
  await writeWebp(await page.screenshot({ clip: box, animations: 'disabled' }), path);
  return path;
}

/**
 * Encode a png as lossless webp: pixel-exact, and under half the bytes of the png for UI text,
 * where lossy webp comes out larger. Webp caps each side at 16383 px.
 */
async function writeWebp(png: Buffer, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const args = ['-y', '-v', 'error', '-f', 'png_pipe', '-i', 'pipe:0'];
  try {
    execFileSync('ffmpeg', [...args, '-c:v', 'libwebp', '-lossless', '1', '-compression_level', '6', path], {
      input: png,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (error) {
    throw new Error(`ffmpeg could not write ${path}\n${String((error as { stderr?: Buffer }).stderr ?? '').trim()}`);
  }
}

/** Width and height of a webp `writeWebp` wrote, read from its lossless header. */
export function webpSize(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 25);
  if (header.toString('latin1', 12, 16) !== 'VP8L') throw new Error(`${path} is not a lossless webp`);
  const bits = header.readUInt32LE(21);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/**
 * Before and after webps side by side (stacked when wide), labelled, in one 1x image, so one read
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
    return `<figure><figcaption>${label}</figcaption><img src="data:image/webp;base64,${data}" style="width:${webpSize(path).width / scale}px"></figure>`;
  };
  const row = Math.max(webpSize(before).width, webpSize(after).width) / scale <= 700;
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 100, height: 100 } });
  try {
    const page = await context.newPage();
    await page.setContent(
      `<style>body{margin:0;font:600 13px system-ui;background:#fff}main{display:inline-flex;flex-direction:${row ? 'row' : 'column'};gap:12px;padding:12px}figure{margin:0}figcaption{margin-bottom:4px;color:#555}img{display:block;outline:1px solid #ddd}</style>` +
        `<main>${await cell(labels[0], before)}${await cell(labels[1], after)}</main>`,
    );
    await writeWebp(await page.locator('main').screenshot(), out);
  } finally {
    await context.close();
  }
  return out;
}
