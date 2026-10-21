// Packages this host's release binary the way a release ships it, then proves the package: the
// archive goes to `out/diffle-<target>` with the licence files, a checksum list beside a copy of
// it is served over HTTP, and the installers install from there as a user would, running the
// installed binary's --version before they report success. usage: node scripts/package-binary.ts
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const windows = process.platform === 'win32';
const target = `${windows ? 'windows' : process.platform}-${process.arch}`;
const archive = `diffle-${target}.${windows ? 'zip' : 'tar.gz'}`;

const out = join(ROOT, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
// bsdtar, which every runner has, picks the format from the extension with -a: a zip for Windows.
const binary = windows ? 'diffle.exe' : 'diffle';
execFileSync(
  'tar',
  [
    '-a',
    '-c',
    '-f',
    join(out, archive),
    '-C',
    'target/release',
    binary,
    '-C',
    '../..',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);

// A one-asset release: the archive and its checksum, as the installers read them.
const release = mkdtempSync(join(tmpdir(), 'diffle-release-'));
const installed = mkdtempSync(join(tmpdir(), 'diffle-bin-'));
try {
  cpSync(join(out, archive), join(release, archive));
  const sum = createHash('sha256')
    .update(readFileSync(join(out, archive)))
    .digest('hex');
  writeFileSync(join(release, 'SHA256SUMS'), `${sum}  ${archive}\n`);
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\/+/, ''));
    if (name !== archive && name !== 'SHA256SUMS') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(readFileSync(join(release, name)));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  const env = { ...process.env, DIFFLE_DOWNLOAD_URL: `http://127.0.0.1:${port}`, DIFFLE_INSTALL_DIR: installed };
  // The installers run while the server answers them, so they must not block the event loop.
  const run = (program: string, args: string[]) =>
    new Promise<void>((done, fail) => {
      const child = spawn(program, args, { cwd: ROOT, env, stdio: 'inherit' });
      child.on('error', fail);
      child.on('exit', (code) =>
        code === 0 ? done() : fail(new Error(`${program} ${args.join(' ')} exited ${code}`)),
      );
    });
  try {
    if (windows) {
      await run('pwsh', ['-NoProfile', '-File', 'scripts/install.ps1']);
      // Again under Windows PowerShell 5.1, over the existing install.
      await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/install.ps1']);
    } else {
      await run('sh', ['scripts/install.sh']);
    }
  } finally {
    server.close();
  }
  console.error(`packaged out/${archive}, and the installer installed it from a served release`);
} finally {
  rmSync(release, { recursive: true, force: true });
  rmSync(installed, { recursive: true, force: true });
}
