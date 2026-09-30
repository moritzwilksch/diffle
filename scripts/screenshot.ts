// Capture a UI change: `npm run screenshot -- <scenario.ts> [--before <rev>] [--out <dir>]`.
//
// Runs the scenario against this checkout and, with --before, against that revision's own server
// and client. Prints only where the images went; build, server and ffmpeg output appear on failure.
import type { Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import * as browser from '../test/e2e/browser.js';
import {
  baseCheckout,
  clip,
  compare,
  crop,
  demoRepo,
  newVideoPage,
  pngSize,
  saveVideo,
  videoDuration,
  type DemoRepoSpec,
} from '../test/e2e/capture.js';
import {
  REPO_ROOT,
  buildClient,
  readPrompt,
  readThreads,
  resetReviewState,
  seedThreads,
  waitForLsp,
  withDiffle,
} from '../test/e2e/server.js';
import { buildFixtureRepo, FEATURE_BRANCH, MAIN_BRANCH } from '../test/fixture/repo.js';
import { rmTmp } from '../test/tmp.js';

const { activePath, clickLine, collapsed, filePaths, gotoFile, header, hoverSymbol, openModePicker } = browser;
const { selectLines, setViewed, toggleCollapse, viewed, waitForHighlight, walkToFile } = browser;
const PAGE_VERBS = {
  activePath,
  clickLine,
  collapsed,
  filePaths,
  gotoFile,
  header,
  hoverSymbol,
  openModePicker,
  selectLines,
  setViewed,
  toggleCollapse,
  viewed,
  waitForHighlight,
  walkToFile,
};

type Bound<F> = F extends (page: Page, ...args: infer A) => infer R ? (...args: A) => R : never;
type PageVerbs = { [K in keyof typeof PAGE_VERBS]: Bound<(typeof PAGE_VERBS)[K]> };

/** What a scenario's default export receives. */
export interface ScenarioContext extends PageVerbs {
  page: Page;
  url: string;
  repo: string;
  side: 'before' | 'after';
  assert: typeof assert;
  /** Crop a selector or locator, or clip a CSS-pixel box, to `<label>-<side>.png`. */
  shot(label: string, target?: string | ReturnType<Page['locator']> | Box): Promise<string>;
  seedThreads: (threads: Parameters<typeof seedThreads>[1]) => ReturnType<typeof seedThreads>;
  readThreads: () => ReturnType<typeof readThreads>;
  readPrompt: () => ReturnType<typeof readPrompt>;
  waitForLsp: () => ReturnType<typeof waitForLsp>;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A scenario module. Every export but the default is optional. */
export interface Scenario {
  /** The fixture repository (default), files for a demo repo, or an absolute repo path. */
  repo?: 'fixture' | DemoRepoSpec | string;
  /** Revisions: the fixture's merge-base view, `HEAD~1..HEAD` for a committed demo, else none. */
  revs?: string[];
  /** Further diffle flags, e.g. `['--lsp']`. */
  args?: string[];
  /** Runs before the page opens; seed server state here. */
  setup?: (ctx: Pick<ScenarioContext, 'url' | 'repo' | 'side' | 'seedThreads'>) => Promise<unknown>;
  viewport?: browser.PageOptions;
  /** Record each side to `<scenario>-<side>.mp4` at 1x instead of opening a still page. */
  video?: boolean;
  default: (ctx: ScenarioContext) => Promise<void>;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { before: { type: 'string' }, out: { type: 'string' } },
});
if (positionals.length !== 1) {
  console.error('usage: npm run screenshot -- <scenario.ts> [--before <rev>] [--out <dir>]');
  process.exit(2);
}
const file = resolve(positionals[0]!);
const scenario = (await import(pathToFileURL(file).href)) as Scenario;
if (typeof scenario.default !== 'function') throw new Error(`${file} must export a default async function`);

const name = basename(file).replace(/\.[cm]?[jt]s$/, '');
const out = resolve(values.out ?? join(tmpdir(), 'diffle-shots', name));
await mkdir(out, { recursive: true });
// Drop the previous run's outputs, so a failed or renamed shot cannot pass for a fresh one.
for (const entry of readdirSync(out)) {
  if (/-(before|after|compare)\.(png|mp4)$|^failure-/.test(entry)) rmSync(join(out, entry));
}

const spec = scenario.repo ?? 'fixture';
let temp: string | null = null;
let repo: string;
let revs: string[];
if (spec === 'fixture') {
  temp = await mkdtemp(join(tmpdir(), 'diffle-shot-'));
  repo = join(temp, 'tally');
  await buildFixtureRepo(repo);
  revs = scenario.revs ?? [`${MAIN_BRANCH}...${FEATURE_BRANCH}`];
} else if (typeof spec === 'object') {
  repo = temp = await demoRepo(spec);
  revs = scenario.revs ?? (spec.commit === false ? [] : ['HEAD~1..HEAD']);
} else {
  repo = resolve(spec);
  revs = scenario.revs ?? [];
}

buildClient();
const sides: ['before' | 'after', string][] = [['after', REPO_ROOT]];
if (values.before) sides.push(['before', baseCheckout(values.before)]);

const clean = (text: unknown) =>
  stripVTControlCharacters(String(text))
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 4)
    .join('\n    ');
const lines: string[] = [];
const shots = { before: new Set<string>(), after: new Set<string>() };
let failed = false;

const chromium = await browser.openBrowser();
try {
  for (const [side, root] of sides) {
    resetReviewState(repo);
    await withDiffle({ repo, revs, root, args: scenario.args ?? [] }, async ({ url }) => {
      const bound = {
        seedThreads: (threads: Parameters<typeof seedThreads>[1]) => seedThreads(url, threads),
        readThreads: () => readThreads(url),
        readPrompt: () => readPrompt(url),
        waitForLsp: () => waitForLsp(url),
      };
      if (scenario.setup) await scenario.setup({ url, repo, side, seedThreads: bound.seedThreads });
      const opts = scenario.viewport ?? {};
      const recording = scenario.video ? await newVideoPage(chromium, url, { ...opts, dir: out }) : null;
      const page = recording?.page ?? (await browser.newPage(chromium, url, opts));
      const verbs = Object.fromEntries(
        Object.entries(PAGE_VERBS).map(([verb, fn]) => [
          verb,
          (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(page, ...args),
        ]),
      ) as PageVerbs;
      const shot: ScenarioContext['shot'] = async (label, target = 'body') => {
        const path = join(out, `${label}-${side}.png`);
        if (typeof target === 'object' && 'x' in target) await clip(page, target, path);
        else await crop(page, target, path);
        shots[side].add(label);
        const { width, height } = pngSize(path);
        lines.push(`  ${basename(path)} ${width}×${height}`);
        return path;
      };
      try {
        await scenario.default({ page, url, repo, side, assert, shot, ...bound, ...verbs });
      } catch (error) {
        failed = true;
        const where = String((error as Error).stack ?? '')
          .split('\n')
          .find((line) => line.includes(file));
        const failure = join(out, `failure-${side}.png`);
        await page.screenshot({ path: failure, scale: 'css' }).catch(() => {});
        lines.push(`FAIL ${side}: ${clean((error as Error).message)}${where ? `\n    ${where.trim()}` : ''}`);
        lines.push(`  ${basename(failure)} (viewport at failure)`);
      } finally {
        if (recording) {
          const mp4 = await saveVideo(recording.context, recording.video, join(out, `${name}-${side}.mp4`));
          lines.push(`  ${basename(mp4)} ${videoDuration(mp4).toFixed(1)}s`);
        } else await page.context().close();
      }
    });
  }
  for (const label of shots.after) {
    if (!shots.before.has(label)) continue;
    const path = await compare(chromium, {
      before: join(out, `${label}-before.png`),
      after: join(out, `${label}-after.png`),
      out: join(out, `${label}-compare.png`),
      labels: [`Before (${values.before})`, 'After'],
      scale: scenario.viewport?.scale ?? 2,
    });
    const { width, height } = pngSize(path);
    lines.push(`  ${basename(path)} ${width}×${height}  ← read this to verify`);
  }
} finally {
  await chromium.close();
  if (temp) await rmTmp(temp);
}

console.log([out, ...lines].join('\n'));
process.exitCode = failed ? 1 : 0;
