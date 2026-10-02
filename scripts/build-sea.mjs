// Packs dist/sea/main.js and dist/client into one executable for the running node's platform.
// Run after `npm run build`; writes dist/sea/diffle (diffle.exe on Windows).
import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const clientDir = 'dist/client';
const output = join('dist', 'sea', process.platform === 'win32' ? 'diffle.exe' : 'diffle');

const assets = {};
for (const entry of readdirSync(clientDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = join(entry.parentPath, entry.name);
  assets[relative(clientDir, file).split(sep).join('/')] = file;
}

const config = join('dist', 'sea', 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify(
    {
      main: 'dist/sea/main.js',
      mainFormat: 'module',
      output,
      disableExperimentalSEAWarning: true,
      assets,
    },
    null,
    2,
  ),
);

execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
// Injection invalidates node's signature; macOS kills unsigned arm64 binaries, so re-sign ad hoc.
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', '--force', output], { stdio: 'inherit' });
console.error(`built ${output}`);
