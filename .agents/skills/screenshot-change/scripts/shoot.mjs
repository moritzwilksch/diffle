#!/usr/bin/env node
// Run a capture scenario against this checkout and, with --before, against a base revision.
//
//   node .agents/skills/screenshot-change/scripts/shoot.mjs <scenario.mjs> [--before <rev>] [--out <dir>]
//
// Prints only where the images went; build and server output appear only on failure.
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import * as h from './harness.mjs';

const {
  activePath,
  collapsed,
  filePaths,
  gotoFile,
  header,
  openModePicker,
  selectLines,
  setViewed,
  toggleCollapse,
  viewed,
} = h;
const PAGE_VERBS = {
  activePath,
  collapsed,
  filePaths,
  gotoFile,
  header,
  openModePicker,
  selectLines,
  setViewed,
  toggleCollapse,
  viewed,
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { before: { type: 'string' }, out: { type: 'string' } },
});
if (positionals.length !== 1) {
  console.error('usage: shoot.mjs <scenario.mjs> [--before <rev>] [--out <dir>]');
  process.exit(2);
}
const file = resolve(positionals[0]);
const scenario = await import(pathToFileURL(file).href);
if (typeof scenario.default !== 'function') throw new Error(`${file} must export a default async function`);
if (!scenario.repo) throw new Error(`${file} must export \`repo\`: { before, after } files or a repo path`);

const name = basename(file).replace(/\.m?js$/, '');
const out = resolve(values.out ?? join(tmpdir(), 'diffle-shots', name));
await mkdir(out, { recursive: true });
// Drop the previous run's outputs, so a failed or renamed shot cannot pass for a fresh one.
for (const entry of readdirSync(out)) {
  if (/-(before|after|compare)\.(png|mp4)$|^failure-/.test(entry)) rmSync(join(out, entry));
}

const demo = typeof scenario.repo === 'object';
const repo = demo ? await h.demoRepo(scenario.repo) : resolve(scenario.repo);
const revs = scenario.revs ?? (demo && scenario.repo.commit !== false ? ['HEAD~1..HEAD'] : []);
const sides = [['after', h.REPO_ROOT]];
h.buildClient();
if (values.before) sides.push(['before', h.baseCheckout(values.before)]);

const clean = (text) =>
  stripVTControlCharacters(String(text))
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 4)
    .join('\n    ');
const lines = [];
const shots = { before: new Set(), after: new Set() };
let failed = false;

const browser = await h.openBrowser();
try {
  for (const [side, root] of sides) {
    h.resetReviewState(repo);
    await h.withDiffle({ repo, revs, root, args: scenario.args ?? [] }, async ({ url }) => {
      const bound = { seedThreads: (t) => h.seedThreads(url, t), readThreads: () => h.readThreads(url) };
      if (scenario.setup) await scenario.setup({ url, repo, side, h, ...bound });
      const opts = scenario.viewport ?? {};
      const recording = scenario.video ? await h.newVideoPage(browser, url, { ...opts, dir: out }) : null;
      const page = recording?.page ?? (await h.newPage(browser, url, opts));
      const ctx = { page, url, repo, side, out, h, assert, ...bound };
      for (const [verb, fn] of Object.entries(PAGE_VERBS)) ctx[verb] = (...args) => fn(page, ...args);
      ctx.shot = async (label, target = 'body') => {
        const path = join(out, `${label}-${side}.png`);
        const box = target && typeof target === 'object' && 'x' in target && 'width' in target;
        await (box ? h.clip(page, target, path) : h.crop(page, target, path));
        shots[side].add(label);
        const { width, height } = h.pngSize(path);
        lines.push(`  ${basename(path)} ${width}×${height}`);
        return path;
      };
      try {
        await scenario.default(ctx);
      } catch (error) {
        failed = true;
        const where = String(error.stack ?? '')
          .split('\n')
          .find((line) => line.includes(file));
        const shotPath = join(out, `failure-${side}.png`);
        await page.screenshot({ path: shotPath, scale: 'css' }).catch(() => {});
        lines.push(
          `FAIL ${side}: ${clean(error.message)}${where ? `\n    ${where.trim()}` : ''}\n  ${basename(shotPath)} (viewport at failure)`,
        );
      } finally {
        if (recording) {
          const mp4 = await h.saveVideo(recording.context, recording.video, join(out, `${name}-${side}.mp4`));
          lines.push(`  ${basename(mp4)} ${h.videoDuration(mp4).toFixed(1)}s`);
        } else await page.context().close();
      }
    });
  }
  for (const label of shots.after) {
    if (!shots.before.has(label)) continue;
    const path = await h.compare(browser, {
      before: join(out, `${label}-before.png`),
      after: join(out, `${label}-after.png`),
      out: join(out, `${label}-compare.png`),
      labels: [`Before (${values.before})`, 'After'],
      scale: scenario.viewport?.scale ?? 2,
    });
    const { width, height } = h.pngSize(path);
    lines.push(`  ${basename(path)} ${width}×${height}  ← read this to verify`);
  }
} finally {
  await browser.close();
  if (demo) rmSync(repo, { recursive: true, force: true });
}

console.log([out, ...lines].join('\n'));
process.exitCode = failed ? 1 : 0;
