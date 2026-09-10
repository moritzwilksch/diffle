import { rm } from 'node:fs/promises';

/**
 * Removes a temp directory, retrying while the OS still holds it. On Windows an
 * idle `git cat-file --batch` keeps the repo root as its cwd until it is reaped,
 * and rmdir fails with EBUSY until then.
 */
export function rmTmp(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
