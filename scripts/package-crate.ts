// Packages the crate as crates.io receives it, then proves the package: the licence files go in
// beside the client build, and `cargo package` compiles the result on its own, outside the
// workspace. Fails when the archive nears the registry's size limit. Run after `npm run build`.
// usage: node scripts/package-crate.ts
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CRATE = join(ROOT, 'crates/diffle');
// crates.io refuses a .crate over 10 MB; the margin leaves time to act before a release fails.
const LIMIT = 10 * 1000 * 1000;
const BUDGET = 0.8 * LIMIT;

if (!existsSync(join(CRATE, 'client/index.html')))
  throw new Error('crates/diffle/client is missing: run npm run build');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(join(ROOT, name), join(CRATE, name));

const metadata = execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const { packages } = JSON.parse(metadata) as { packages: { name: string; version: string }[] };
const { version } = packages.find(({ name }) => name === 'diffle')!;
// The client build and the licence copies are git-ignored, which cargo reads as a dirty tree.
execFileSync('cargo', ['package', '--locked', '--allow-dirty', '-p', 'diffle'], { cwd: ROOT, stdio: 'inherit' });

const archive = join(ROOT, 'target/package', `diffle-${version}.crate`);
const size = statSync(archive).size;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
if (size > BUDGET)
  throw new Error(`${archive} is ${mb(size)}, over the ${mb(BUDGET)} budget for crates.io's ${mb(LIMIT)} limit`);
console.error(`packaged target/package/diffle-${version}.crate: ${mb(size)} of crates.io's ${mb(LIMIT)}`);
