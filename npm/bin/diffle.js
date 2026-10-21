#!/usr/bin/env node
// Runs this platform's diffle binary, installed as an optional dependency: the launcher is what
// lets `npm install -g` and `npx` work for a native program. It only waits and relays the exit.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const platform = `${process.platform}-${process.arch}`;
const name = `@moritzwilksch/diffle-${platform}`;
let binary;
try {
  const dir = dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  binary = join(dir, process.platform === 'win32' ? 'diffle.exe' : 'diffle');
} catch {
  console.error(
    `diffle has no npm package for ${platform} (${name} is not installed).\n` +
      'Other ways to install: https://github.com/moritzwilksch/diffle#install',
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
// Ctrl+C reaches the binary through the shared terminal; it shuts down and prints its prompt,
// so the launcher must outlive the signal and report the binary's own exit.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});
child.on('error', (error) => {
  console.error(`could not start ${binary}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
