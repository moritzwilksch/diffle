// Loads a review in Chromium and measures how the client copes: first paint, how long it keeps
// fetching, main-thread long tasks, heap, and a keypress's latency once loaded.
// usage: npx tsx scripts/bench/browser.ts <repo> <label> [--max-seconds <s>] [--profile] [--load-oversized]
//          [--chromium <path>] [--shot <png>] [--bin <diffle>] [--out <jsonl>] -- [diffle revisions...]
import { chromium, type Page, type Request } from '@playwright/test';
import { parseArgs } from 'node:util';
import { DEFAULT_BIN, memoryMb, record, serve } from './diffle.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'max-seconds': { type: 'string', default: '240' },
    profile: { type: 'boolean', default: false },
    'load-oversized': { type: 'boolean', default: false },
    chromium: { type: 'string' },
    shot: { type: 'string' },
    bin: { type: 'string', default: DEFAULT_BIN },
    out: { type: 'string' },
  },
});
const [repo, label, ...revs] = positionals;
if (!repo || !label) throw new Error('usage: browser.ts <repo> <label> [options] -- [revisions...]');

declare global {
  interface Window {
    longTasks: { count: number; total: number; max: number };
  }
}

const served = await serve(values.bin, repo, revs);
const browser = await chromium.launch({ executablePath: values.chromium });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.addInitScript(() => {
  window.longTasks = { count: 0, total: 0, max: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.longTasks.count++;
      window.longTasks.total += e.duration;
      window.longTasks.max = Math.max(window.longTasks.max, e.duration);
    }
  }).observe({ type: 'longtask', buffered: true });
});
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
if (values.profile) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');
}

// API traffic: requests by route, and when the last one started or ended.
const inflight = new Set<Request>();
const counts: Record<string, number> = { patch: 0, file: 0, snapshot: 0, other: 0, failed: 0 };
let lastNet = performance.now();
page.on('request', (req) => {
  if (!req.url().includes('/api/')) return;
  inflight.add(req);
  lastNet = performance.now();
  const kind = /\/api\/(patch|file|snapshot)\b/.exec(req.url())?.[1] ?? 'other';
  counts[kind] = (counts[kind] ?? 0) + 1;
});
const ended = (req: Request, failed: boolean) => {
  if (!inflight.delete(req)) return;
  lastNet = performance.now();
  if (failed) counts.failed!++;
};
page.on('requestfinished', (req) => ended(req, false));
page.on('requestfailed', (req) => ended(req, true));

/** Waits until no API request is in flight or started for 3 s, or the deadline passes. */
async function settled(since: number): Promise<{ settledMs: number; timedOut: boolean }> {
  const deadline = since + Number(values['max-seconds']) * 1000;
  while (performance.now() < deadline) {
    await new Promise((res) => setTimeout(res, 250));
    if (inflight.size === 0 && performance.now() - lastNet > 3000) break;
  }
  return { settledMs: Math.round(lastNet - since), timedOut: performance.now() >= deadline };
}

const firstLine = (p: Page) =>
  p.locator('[data-column-number]').first().waitFor({ state: 'attached', timeout: 600_000 });

const t0 = performance.now();
await page.goto(served.base);
const r: Record<string, unknown> = { label, revs: revs.join(' ') };
await page.locator('.codeview').waitFor({ timeout: 600_000 });
r.codeviewMs = Math.round(performance.now() - t0);
await firstLine(page).catch(() => {});
r.firstLineMs = Math.round(performance.now() - t0);
Object.assign(r, await settled(t0), counts);

if (values['load-oversized']) {
  const t = performance.now();
  await page.getByRole('button', { name: 'Load diff' }).first().click();
  await page.locator('[data-placeholder="oversized"]').first().waitFor({ state: 'detached', timeout: 600_000 });
  await firstLine(page);
  r.oversizedPaintMs = Math.round(performance.now() - t);
  r.oversizedSettledMs = (await settled(t)).settledMs;
}

const metrics = Object.fromEntries(
  (await cdp.send('Performance.getMetrics')).metrics.map((m: { name: string; value: number }) => [m.name, m.value]),
);
const long = await page.evaluate(() => window.longTasks);
Object.assign(r, {
  jsHeapMb: Math.round(metrics.JSHeapUsedSize! / 1e6),
  domNodes: metrics.Nodes,
  longTasks: long.count,
  longTaskTotalMs: Math.round(long.total),
  longTaskMaxMs: Math.round(long.max),
});
// Once loaded: how long "next file" takes to reach a painted frame.
r.nextFileKeyMs = Math.round(
  await page.evaluate(
    () =>
      new Promise<number>((res) => {
        const t = performance.now();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
        requestAnimationFrame(() => setTimeout(() => res(performance.now() - t), 0));
      }),
  ),
);
if (values.shot) await page.screenshot({ path: values.shot });
r.serverPeakRssMb = memoryMb(served.child.pid!).peak;

if (values.profile) {
  interface Node {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }
  const { profile } = (await cdp.send('Profiler.stop')) as {
    profile: { nodes: Node[]; samples: number[]; timeDeltas: number[] };
  };
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const f = byId.get(id)!.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  r.profile = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k, ms]) => `${Math.round(ms)}ms ${k}`);
}
await browser.close();
await served.stop();
record(r, values.out);
