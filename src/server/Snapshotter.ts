import type { ChangedFile, ModeSpec, Snapshot } from '../shared/protocol.js';
import { mapLimit } from './concurrency.js';
import { looksGenerated, SNIFF_BYTES } from './generated.js';
import { GitError, type GitRepo } from './git/GitRepo.js';

const PREWARM = 3;
/** Concurrent worktree reads while flagging generated files. */
const SNIFF_CONCURRENCY = 8;
/** Sniff verdicts remembered by blob sha; the map is emptied, not evicted, past this. */
const SNIFF_CACHE_MAX = 20_000;

/** Turns ModeSpec + GitRepo into a Snapshot. Cached until invalidate(). */
export class Snapshotter {
  private cache: Promise<Snapshot> | null = null;
  private patches = new Map<string, Promise<string>>();
  private all: Promise<string> | null = null;
  /** Content-sniff verdict by blob sha. A blob is immutable, so a refresh re-reads only new content. */
  private sniffed = new Map<string, boolean>();

  constructor(
    private readonly repo: GitRepo,
    readonly mode: ModeSpec,
    private version: number,
    private context: number,
  ) {}

  /** Change context lines: drops cached patches; the next snapshot carries the new value. */
  setContext(context: number, version: number): void {
    if (context === this.context) return;
    this.context = context;
    this.invalidate(version);
  }

  current(): Promise<Snapshot> {
    if (this.cache == null) {
      const version = this.version;
      this.cache = this.compute(version).catch((e) => {
        if (this.version === version) this.cache = null;
        throw e;
      });
    }
    return this.cache;
  }

  invalidate(version: number): void {
    this.version = version;
    this.cache = null;
    this.patches.clear();
    this.all = null;
  }

  async patch(path: string): Promise<string | null> {
    const snap = await this.current();
    const file = snap.changed.find((f) => f.path === path);
    if (file == null) return null;
    return this.patchFor(snap, file);
  }

  /** Every changed file's patch, concatenated. One git call plus untracked files. */
  async patchAll(): Promise<string> {
    const snap = await this.current();
    if (this.all == null) {
      this.all = this.repo.patchAll(snap.oldSha, snap.newSha, snap.changed, this.context);
      this.all.catch(() => (this.all = null));
    }
    return this.all;
  }

  /** Patches for `paths`, concatenated: cached ones as they are, the rest in one git call. Unknown paths are skipped. */
  async patchMany(paths: string[]): Promise<string> {
    const snap = await this.current();
    const byPath = new Map(snap.changed.map((f) => [f.path, f]));
    const cached: Promise<string>[] = [];
    const rest: ChangedFile[] = [];
    for (const p of new Set(paths)) {
      const f = byPath.get(p);
      if (f == null) continue;
      const c = this.patches.get(p);
      if (c) cached.push(c);
      else rest.push(f);
    }
    // One file goes through the per-file cache, so a later single request finds it.
    const batch = rest.length === 1 ? this.patchFor(snap, rest[0]!) : rest.length ? this.repo.patchMany(snap.oldSha, snap.newSha, rest, this.context) : Promise.resolve('');
    return [...(await Promise.all(cached)), await batch].join('');
  }

  private patchFor(snap: Snapshot, file: ChangedFile): Promise<string> {
    let p = this.patches.get(file.path);
    if (p == null) {
      p = this.repo.patch(snap.oldSha, snap.newSha, file, this.context);
      this.patches.set(file.path, p);
      p.catch(() => this.patches.delete(file.path));
    }
    return p;
  }

  private async compute(version: number): Promise<Snapshot> {
    const [oldSha, newSha, headSha] = await Promise.all([this.resolveOld(), this.resolveNew(), this.repo.resolve('HEAD').catch(() => '')]);
    // The tree belongs to the selected new side: a commit's own listing, or the
    // index plus untracked files (added below via `changed`) for the worktree.
    const [tracked, changed] = await Promise.all([
      newSha === 'worktree' ? this.repo.lsFiles() : this.repo.lsTree(newSha),
      this.repo.numstat(oldSha, newSha),
    ]);
    await this.fillGenerated(changed, newSha);
    const tree = new Set(tracked);
    for (const f of changed) {
      if (f.status === 'D') tree.delete(f.path);
      else tree.add(f.path);
      if (f.oldPath) tree.delete(f.oldPath);
    }
    const snap: Snapshot = {
      root: this.repo.root,
      mode: this.mode,
      version,
      oldSha,
      newSha,
      headSha,
      context: this.context,
      changed,
      tree: [...tree].sort(),
    };
    for (const f of changed.slice(0, PREWARM)) void this.patchFor(snap, f).catch(() => {});
    return snap;
  }

  /**
   * Sets `generated` on each non-binary changed file: by path first, then by a
   * SNIFF_BYTES content sniff. Blobs already classified are not read again;
   * commit-side blobs go through one `cat-file --batch`, worktree files through
   * a bounded read each. Never fails the snapshot: a read error means false.
   * Submodules have no contents to sniff.
   */
  private async fillGenerated(files: ChangedFile[], newSha: string | 'worktree'): Promise<void> {
    const textual = files.filter((f) => f.status !== 'D' && !f.binary && !f.submodule);
    const sniff = textual.filter((f) => !(f.generated = looksGenerated(f.path, null)));
    const unknown: ChangedFile[] = [];
    for (const f of sniff) {
      const known = f.blob ? this.sniffed.get(f.blob) : undefined;
      if (known != null) f.generated = known;
      else unknown.push(f);
    }
    if (newSha === 'worktree') {
      await mapLimit(unknown, SNIFF_CONCURRENCY, async (f) => this.classify(f, await this.repo.head('worktree', f.path, SNIFF_BYTES).catch(() => null)));
      return;
    }
    // A missing blob (the sniff cannot fail the snapshot) reads as not generated.
    const heads = await this.repo.blobHeads(unknown.map((f) => f.blob).filter(Boolean), SNIFF_BYTES).catch(() => new Map<string, Buffer>());
    for (const f of unknown) this.classify(f, heads.get(f.blob) ?? null);
  }

  private classify(f: ChangedFile, head: Buffer | null): void {
    f.generated = looksGenerated(f.path, head);
    if (head == null || !f.blob) return;
    if (this.sniffed.size >= SNIFF_CACHE_MAX) this.sniffed.clear();
    this.sniffed.set(f.blob, f.generated);
  }

  private async resolveOld(): Promise<string> {
    const o = this.mode.old;
    if (o.kind !== 'rev') return this.repo.mergeBase(o.a, o.b);
    try {
      return await this.repo.resolve(o.rev);
    } catch (e) {
      // A fresh `git init` has no commit yet (`rev-parse --verify` exits 1), so
      // working mode diffs everything against the empty tree instead of failing.
      if (o.rev === 'HEAD' && e instanceof GitError && e.code === 1) return this.repo.emptyTree();
      throw e;
    }
  }

  private resolveNew(): Promise<string | 'worktree'> {
    return this.mode.newRev === 'worktree' ? Promise.resolve('worktree') : this.repo.resolve(this.mode.newRev);
  }
}
