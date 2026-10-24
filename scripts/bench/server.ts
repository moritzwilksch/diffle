// Times diffle's server over one review: startup, the snapshot, patches the way the client asks
// for them, the unbatched patch route and a repository search.
// usage: npx tsx scripts/bench/server.ts <repo> <label> [--bin <diffle>] [--out <jsonl>] [--max-files <n>]
//          [--skip-all] [--mutate <shell command>] -- [diffle revisions...]
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DEFAULT_BIN, cpuMs, memoryMb, record, serve, timings } from './diffle.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bin: { type: 'string', default: DEFAULT_BIN },
    out: { type: 'string' },
    'max-files': { type: 'string', default: '2000' },
    'skip-all': { type: 'boolean', default: false },
    mutate: { type: 'string' },
  },
});
const [repo, label, ...revs] = positionals;
if (!repo || !label) throw new Error('usage: server.ts <repo> <label> [options] -- [revisions...]');

/** The client's patch batches carry at most this many files (`PATCH_BATCH_FILES` is 12; fewer requests here). */
const BATCH = 50;

const served = await serve(values.bin, repo, revs);
const started = performance.now() - served.listenMs;
let peak = 0;
const sampler = setInterval(() => (peak = Math.max(peak, memoryMb(served.child.pid!).rss)), 20);

async function timed(path: string, init?: RequestInit) {
  const t = performance.now();
  const res = await fetch(new URL(path, served.base), init);
  const body = await res.text();
  return { status: res.status, ms: Math.round(performance.now() - t), bytes: body.length, body };
}

const r: Record<string, unknown> = { label, revs: revs.join(' '), listenMs: served.listenMs };
interface Snapshot {
  changed: { path: string; additions: number; deletions: number }[];
  tree: string[];
  commits?: { total: number };
}
const snap = await timed('api/snapshot');
r.snapshotReadyMs = Math.round(performance.now() - started);
const s = JSON.parse(snap.body) as Snapshot;
Object.assign(r, {
  snapshotBytes: snap.bytes,
  changed: s.changed.length,
  tree: s.tree.length,
  additions: s.changed.reduce((a, f) => a + f.additions, 0),
  deletions: s.changed.reduce((a, f) => a + f.deletions, 0),
  commits: s.commits?.total,
  cachedSnapshotMs: (await timed('api/snapshot')).ms,
});

const paths = s.changed.map((f) => f.path);
if (paths.length > 0) {
  r.patchOneMs = (await timed(`api/patch?path=${encodeURIComponent(paths[paths.length >> 1]!)}`)).ms;
  const t = performance.now();
  let [bytes, batches, worst] = [0, 0, 0];
  for (let i = 0; i < Math.min(paths.length, Number(values['max-files'])); i += BATCH) {
    const b = await timed('api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: paths.slice(i, i + BATCH) }),
    });
    [bytes, batches, worst] = [bytes + b.bytes, batches + 1, Math.max(worst, b.ms)];
  }
  Object.assign(r, {
    patchBatchesMs: Math.round(performance.now() - t),
    patchBatches: batches,
    patchBatchWorstMs: worst,
    patchBatchBytes: bytes,
  });
  if (!values['skip-all']) {
    const all = await timed('api/patch');
    Object.assign(r, { patchAllMs: all.ms, patchAllBytes: all.bytes });
  }
}
const search = await timed(`api/search?${new URLSearchParams({ q: 'static int', scope: 'repo', content: 'full' })}`);
Object.assign(r, { searchMs: search.ms, searchStatus: search.status });

// Refresh latency: from the mutation until the server announces a new snapshot.
if (values.mutate) {
  const ws = new WebSocket(new URL('ws', served.base.replace(/^http/, 'ws')));
  await new Promise((res) => ws.addEventListener('open', res));
  await new Promise((res) => setTimeout(res, 1500));
  const cpu = cpuMs(served.child.pid!);
  const t = performance.now();
  const announced = new Promise<number>((res) => {
    ws.addEventListener('message', (e) => {
      if ((JSON.parse(String(e.data)) as { type: string }).type === 'snapshot') res(performance.now() - t);
    });
  });
  spawn('sh', ['-c', values.mutate], { cwd: repo, stdio: 'ignore' });
  const timeout = new Promise<number>((res) => setTimeout(() => res(-1), 60_000));
  r.refreshAnnounceMs = Math.round(await Promise.race([announced, timeout]));
  const again = await timed('api/snapshot');
  Object.assign(r, {
    refreshSnapshotMs: again.ms,
    refreshChanged: (JSON.parse(again.body) as Snapshot).changed.length,
    refreshCpuMs: cpuMs(served.child.pid!) - cpu,
  });
  ws.close();
}
clearInterval(sampler);
Object.assign(r, { peakRssMb: Math.max(peak, memoryMb(served.child.pid!).peak), timing: timings(served.stderr()) });
await served.stop();
record(r, values.out);
