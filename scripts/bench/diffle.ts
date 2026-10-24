// Shared by the large-repository benchmarks: start a diffle over a repository and read its
// resource use. Process accounting reads /proc, so the numbers are Linux-only.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_BIN = resolve(import.meta.dirname, '../../target/release/diffle');

export interface Served {
  base: string;
  child: ChildProcess;
  /** Milliseconds from spawn until the status line named the URL. */
  listenMs: number;
  stderr: () => string;
  stop: () => Promise<void>;
}

/** Serves `args` over `repo` on a random port, without a browser or language servers. */
export async function serve(bin: string, repo: string, args: string[], waitFor = /running at /): Promise<Served> {
  const started = performance.now();
  const child = spawn(bin, [...args, '--no-open', '--keep-alive', '--no-lsp', '--timing', '-p', '0'], {
    cwd: repo,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  let err = '';
  const base = await new Promise<string>((res, rej) => {
    child.stderr!.on('data', (d: Buffer) => {
      err += d;
      const url = /running at (http:\/\/\S+?\/)\s/.exec(err)?.[1];
      if (url && waitFor.test(err)) res(url);
    });
    child.on('exit', (code) => rej(new Error(`diffle exited ${code}:\n${err}`)));
  });
  const stop = async () => {
    if (child.exitCode != null) return;
    child.kill('SIGINT');
    await new Promise((res) => child.once('exit', res));
  };
  return { base, child, listenMs: Math.round(performance.now() - started), stderr: () => err, stop };
}

const status = (pid: number) => readFileSync(`/proc/${pid}/status`, 'utf8');
const kb = (text: string, field: string) => Number(new RegExp(`${field}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);

/** Resident set now, and its high-water mark, in MB. */
export function memoryMb(pid: number): { rss: number; peak: number } {
  const s = status(pid);
  return { rss: Math.round(kb(s, 'VmRSS') / 1024), peak: Math.round(kb(s, 'VmHWM') / 1024) };
}

/** CPU time of `pid` plus its reaped children (the git processes it ran), in ms. */
export function cpuMs(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  // utime, stime, cutime, cstime in clock ticks (100 per second on Linux).
  return [11, 12, 13, 14].reduce((sum, i) => sum + Number(fields[i]), 0) * 10;
}

/** `[timing]` phases from `--timing`, as `phase=ms` pairs. */
export function timings(stderr: string): string {
  return [...stderr.matchAll(/\[timing\] (\S+)\s+\+\s*([\d.]+) ms/g)].map((m) => `${m[1]}=${m[2]}`).join(' ');
}

/** Prints one result and appends it to `out` as a JSON line, when given. */
export function record(result: object, out: string | undefined): void {
  const line = JSON.stringify(result);
  console.log(line);
  if (out) appendFileSync(out, line + '\n');
}
