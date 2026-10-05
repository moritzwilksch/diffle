import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followsCheckout, type Snapshot } from '../../shared/protocol.js';
import type { GitRepo } from '../git/GitRepo.js';

/** What the pool needs from a workspace; `LspWorkspace` satisfies it, tests inject fakes. */
export interface Workspace {
  /** A directory whose files are the snapshot's new side, for a language server to index. */
  rootFor(snap: Pick<Snapshot, 'newSha' | 'headSha'>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Where language servers run for a snapshot. A server indexes a directory on disk while the
 * bridge feeds it the reviewed text of the files it is asked about, so the two must agree:
 * the repository itself serves a snapshot whose new side is the checkout (the worktree, or
 * HEAD's commit). Any other new side (a pull request, a focused commit, an older range) gets
 * a detached worktree this session adds under the temp dir and moves to that commit. The
 * user's checkout is never touched; the worktree is removed on close. A checked-out commit
 * has no installed dependencies, so servers there resolve what the repository holds and what
 * their own caches do.
 */
export class LspWorkspace implements Workspace {
  private checkout: { dir: string; sha: string } | null = null;
  /** The newest commit asked for; a queued move skips straight to it. */
  private wanted: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor(
    private readonly repo: GitRepo,
    private readonly opts: { onCreate?: (dir: string) => void } = {},
  ) {}

  /** The detached worktree, once a snapshot needed one. */
  get dir(): string | null {
    return this.checkout?.dir ?? null;
  }

  rootFor(snap: Pick<Snapshot, 'newSha' | 'headSha'>): Promise<string> {
    if (followsCheckout(snap)) return Promise.resolve(this.repo.root);
    this.wanted = snap.newSha;
    return this.run(async () => {
      if (this.closing) throw new Error('the language servers are shutting down');
      const sha = this.wanted!;
      if (!this.checkout) {
        // mkdtemp claims the name; git accepts the empty directory it leaves.
        const dir = await mkdtemp(join(tmpdir(), 'diffle-lsp-'));
        try {
          await this.repo.addWorktree(dir, sha);
        } catch (e) {
          await rm(dir, { recursive: true, force: true });
          throw e;
        }
        this.checkout = { dir, sha };
        this.opts.onCreate?.(dir);
      } else if (this.checkout.sha !== sha) {
        await this.repo.checkoutWorktree(this.checkout.dir, sha);
        this.checkout.sha = sha;
      }
      return this.checkout.dir;
    });
  }

  /** Removes the worktree. Callers close the servers running in it first. */
  close(): Promise<void> {
    this.closing = true;
    return this.run(async () => {
      const checkout = this.checkout;
      if (!checkout) return;
      this.checkout = null;
      // A failed `worktree remove` (the repository is gone, or a file is held) still leaves no files behind.
      await this.repo
        .removeWorktree(checkout.dir)
        .catch(() => rm(checkout.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    });
  }

  /** One git process on the worktree at a time, in request order. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn);
    this.queue = r.catch(() => {});
    return r;
  }
}
