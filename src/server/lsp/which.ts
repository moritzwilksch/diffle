import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * The program a shell command line runs: its first word, unquoted. Only ever asked
 * about the built-in candidates, which are plain `prog arg…` lines; a command with a
 * leading assignment or a pipeline has no single program and is never probed (see
 * `resolveServers`).
 */
export function argv0(command: string): string {
  const s = command.trim();
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1);
    return end === -1 ? s.slice(1) : s.slice(1, end);
  }
  return s.split(/\s/, 1)[0] ?? '';
}

/**
 * Where `command`'s program lives, or null when it is not an executable on PATH.
 * A name with a separator is resolved against `cwd` instead of searched, like a shell.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const prog = argv0(command);
  if (!prog) return null;
  if (prog.includes('/') || (process.platform === 'win32' && prog.includes('\\')))
    return executable(isAbsolute(prog) ? prog : resolve(cwd, prog));
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const hit = executable(join(dir, prog));
    if (hit) return hit;
  }
  return null;
}

/**
 * `file` itself when it is a runnable file, else the first `file` + PATHEXT match on
 * Windows, where the execute bit means nothing and programs are `.exe`/`.cmd`.
 */
function executable(file: string): string | null {
  if (runnable(file)) return file;
  if (process.platform !== 'win32') return null;
  for (const ext of (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')) {
    if (ext && runnable(file + ext)) return file + ext;
  }
  return null;
}

function runnable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
