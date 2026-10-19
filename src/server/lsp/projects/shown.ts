import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

/** How a project path reads in the status: repository-relative, else `~`-abbreviated in the home directory, else as is. */
export function shownPath(root: string, path: string): string {
  const inRepo = within(root, path);
  if (inRepo != null) return inRepo || '.';
  const inHome = within(homedir(), path);
  if (inHome != null) return inHome ? `~/${inHome}` : '~';
  return path;
}

/** `path` relative to `dir` with forward slashes, or null when it is not inside it. */
function within(dir: string, path: string): string | null {
  const rel = relative(dir, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}
