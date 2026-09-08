import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface RunInfo {
  port: number;
  url: string;
  pid: number;
  /** Repository root, for a sanity check against the caller's cwd. */
  root: string;
  /** ModeSpec.commentKey, so a caller can see what is being reviewed. */
  commentKey: string;
  startedAt: number;
}

/**
 * `<gitDir>/diffle/server.json`: how `diffle comment` finds the running server.
 * Written 0600 in a 0700 directory on listen, removed on shutdown; a read
 * checks the pid is alive and removes a stale file.
 */
export class RunFile {
  readonly file: string;

  constructor(gitDir: string) {
    this.file = join(gitDir, 'diffle', 'server.json');
  }

  async write(info: RunInfo): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Null when absent, malformed, or the recorded pid is gone (the stale file is removed). */
  async read(): Promise<RunInfo | null> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    let info: RunInfo;
    try {
      info = JSON.parse(raw) as RunInfo;
    } catch {
      await this.remove();
      return null;
    }
    if (typeof info?.port !== 'number' || typeof info.pid !== 'number' || typeof info.url !== 'string') {
      await this.remove();
      return null;
    }
    if (!isAlive(info.pid)) {
      await this.remove();
      return null;
    }
    return info;
  }

  /** Removes the file only while it still names this process, so a newer server's file survives. */
  async removeIfOwn(pid = process.pid): Promise<void> {
    try {
      const info = JSON.parse(await readFile(this.file, 'utf8')) as Partial<RunInfo>;
      if (info.pid !== pid) return;
    } catch {
      /* absent or malformed: nothing to keep */
    }
    await this.remove();
  }

  async remove(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else. Still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
