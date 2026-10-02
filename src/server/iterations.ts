import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { IterationSchema, type Iteration } from '../shared/protocol.js';
import type { GitRepo } from './git/GitRepo.js';
import { withFileLock, writeFileAtomic } from './persist.js';

/** Iterations kept per range; the oldest beyond this are forgotten and unpinned. */
export const MAX_ITERATIONS = 50;

const FileSchema = z.object({
  version: z.literal(1),
  ranges: z.record(z.string(), IterationSchema.array()),
});
type File = z.infer<typeof FileSchema>;

/**
 * The iterations of one range, under its comment key in `<gitDir>/diffle/iterations.json`.
 * Like the comment store, nothing is cached: every mutation is a read-modify-write of fresh
 * disk state under the file lock, so two servers on one repository keep each other's records.
 * Each iteration's commits are pinned under `refs/diffle/iterations/<key hash>/<n>/{old,new}`.
 */
export class IterationStore {
  private readonly file: string;
  private readonly refs: string;

  constructor(
    private readonly repo: GitRepo,
    readonly key: string,
  ) {
    this.file = join(repo.gitDir, 'diffle', 'iterations.json');
    this.refs = `refs/diffle/iterations/${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
  }

  /** Oldest first. */
  async list(): Promise<Iteration[]> {
    return (await read(this.file)).ranges[this.key] ?? [];
  }

  /** The iteration numbered `n`, or null. */
  async get(n: number): Promise<Iteration | null> {
    return (await this.list()).find((it) => it.n === n) ?? null;
  }

  /**
   * Records the endpoints as the next iteration, unless the latest already has them. Returns
   * the list afterwards. Pins the commits first, so a recorded iteration is always reachable.
   */
  async record(oldSha: string, newSha: string): Promise<Iteration[]> {
    return withFileLock(this.file, async () => {
      const all = await read(this.file);
      const list = all.ranges[this.key] ?? [];
      const last = list.at(-1);
      if (last && last.oldSha === oldSha && last.newSha === newSha) return list;
      const n = (last?.n ?? 0) + 1;
      const next = [...list, { n, oldSha, newSha, recordedAt: Date.now() }];
      const dropped = next.splice(0, Math.max(0, next.length - MAX_ITERATIONS));
      await this.repo.pin({
        [`${this.refs}/${n}/old`]: oldSha,
        [`${this.refs}/${n}/new`]: newSha,
        ...Object.fromEntries(
          dropped.flatMap((it) => [
            [`${this.refs}/${it.n}/old`, null],
            [`${this.refs}/${it.n}/new`, null],
          ]),
        ),
      });
      all.ranges[this.key] = next;
      await writeFileAtomic(this.file, JSON.stringify(all, null, 2) + '\n');
      return next;
    });
  }
}

async function read(file: string): Promise<File> {
  try {
    return FileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, ranges: {} };
    throw e;
  }
}
