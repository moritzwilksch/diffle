import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isChecked, type GateInput, type TreeFile } from './guards.js';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const IGNORE_FILES = { files: '.locignore', folders: '.folderignore' };

function countLines(content: Buffer): number {
  return content.toString('utf8').split('\n').length - 1;
}

/** Tracked, modified and new files that git does not ignore, in the working tree; NUL-delimited. */
function listFiles(cwd: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return [
    ...new Set(
      out
        .toString('utf8')
        .split('\0')
        .filter((path) => path !== ''),
    ),
  ];
}

/** A path the index still lists but the working tree lost (deleted, or a submodule) is not in the commit. */
function readTreeFile(cwd: string, path: string): TreeFile | null {
  try {
    return { path, lines: isChecked(path) ? countLines(readFileSync(join(cwd, path))) : 0 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw error;
  }
}

function readPatterns(cwd: string, name: string): string[] {
  const file = join(cwd, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line !== '');
}

/** The whole working tree as the next commit would contain it, not only what is staged. */
export function readGateInput(cwd: string): GateInput {
  return {
    files: listFiles(cwd).flatMap((path) => readTreeFile(cwd, path) ?? []),
    ignore: { files: readPatterns(cwd, IGNORE_FILES.files), folders: readPatterns(cwd, IGNORE_FILES.folders) },
  };
}
