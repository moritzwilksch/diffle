// Runs a command in a repository while diffle watches its worktree, and counts what the watch
// cost: snapshots announced, and CPU spent by diffle and the git processes it ran.
// usage: npx tsx scripts/bench/churn.ts <repo> <label> --cmd <shell command> [--settle <s>] [--bin <diffle>] [--out <jsonl>]
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DEFAULT_BIN, cpuMs, memoryMb, record, serve } from './diffle.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cmd: { type: 'string' },
    settle: { type: 'string', default: '5' },
    bin: { type: 'string', default: DEFAULT_BIN },
    out: { type: 'string' },
  },
});
const [repo, label] = positionals;
if (!repo || !label || !values.cmd) throw new Error('usage: churn.ts <repo> <label> --cmd <shell command>');

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const served = await serve(values.bin, repo, ['working'], /watching/);
const pid = served.child.pid!;
const ws = new WebSocket(new URL('ws', served.base.replace(/^http/, 'ws')));
await new Promise((res) => ws.addEventListener('open', res));
await sleep(2000);
const idle = cpuMs(pid);
await sleep(5000);
const idleCpuPct = Math.round((cpuMs(pid) - idle) / 5) / 10;

let snapshots = 0;
let last = 0;
ws.addEventListener('message', (e) => {
  if ((JSON.parse(String(e.data)) as { type: string }).type !== 'snapshot') return;
  snapshots++;
  last = performance.now();
});
const cpu = cpuMs(pid);
const t = performance.now();
execSync(values.cmd, { cwd: repo, stdio: 'ignore', shell: '/bin/bash' });
const churnMs = performance.now() - t;
await sleep(Number(values.settle) * 1000);
record(
  {
    label,
    idleCpuPct,
    churnMs: Math.round(churnMs),
    snapshots,
    lastSnapshotAfterChurnMs: snapshots > 0 ? Math.round(last - t - churnMs) : null,
    cpuMs: cpuMs(pid) - cpu,
    rssMb: memoryMb(pid).rss,
  },
  values.out,
);
ws.close();
await served.stop();
