// Runs a built binary over a throwaway repo and fetches the page, a script, and a
// grammar, proving the client assets were embedded. usage: node scripts/smoke-binary.ts <binary>
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fail = (msg: string): never => {
  throw new Error(msg);
};
// The same `target/release/diffle` names the binary on every platform; cargo adds the suffix.
const binary = resolve(process.argv[2] ?? '') + (process.platform === 'win32' ? '.exe' : '');
const repo = mkdtempSync(join(tmpdir(), 'diffle-smoke-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git('init', '-q');
git('config', 'user.email', 'smoke@example.com');
git('config', 'user.name', 'smoke');
writeFileSync(join(repo, 'a.txt'), 'one\n');
git('add', '.');
git('commit', '-qm', 'init');
writeFileSync(join(repo, 'a.txt'), 'two\n');

// The URL is read off the status line, so no colour, whatever CI forces on the terminal.
const child = spawn(binary, ['working', '--no-open', '--no-lsp', '--port', '0'], {
  cwd: repo,
  env: { ...process.env, NO_COLOR: '1' },
});
try {
  const base = await new Promise<string>((res, rej) => {
    let err = '';
    const timer = setTimeout(() => rej(new Error(`no url within 30s:\n${err}`)), 30_000);
    child.stderr.on('data', (d: Buffer) => {
      err += d;
      const url = /running at (\S+)/.exec(err)?.[1];
      if (!url) return;
      clearTimeout(timer);
      res(url);
    });
    child.on('exit', (code) => rej(new Error(`exited ${code}:\n${err}`)));
  });

  const fetchOk = async (path: string, type: string) => {
    const res = await fetch(new URL(path, base));
    const got = res.headers.get('content-type') ?? '';
    if (!res.ok || !got.startsWith(type)) throw new Error(`${path}: ${res.status} ${got}`);
    return res.text();
  };
  const html = await fetchOk('/', 'text/html');
  const find = (re: RegExp, text: string, what: string) => re.exec(text)?.[0] ?? fail(`found no ${what}`);
  const script = find(/assets\/index-[\w-]+\.js/, html, 'entry script');
  const entry = await fetchOk(script, 'text/javascript');
  const worker = find(/syntax\.worker-[\w-]+\.js/, entry, 'worker');
  const grammar = find(/typescript-[\w-]+\.js/, entry, 'grammar');
  await fetchOk(`assets/${worker}`, 'text/javascript');
  await fetchOk(`assets/${grammar}`, 'text/javascript');
  await fetchOk('api/snapshot', 'application/json');
  console.error(`smoke ok: ${base} served ${script}, ${worker}, ${grammar}, and api/snapshot`);
} finally {
  child.kill();
  await new Promise<void>((res) => (child.exitCode == null ? child.once('exit', () => res()) : res()));
  rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
}
