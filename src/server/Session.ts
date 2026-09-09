import type { ModeRequest, ModeSpec, ServerMessage, Side, Snapshot } from '../shared/protocol.js';
import { quoteRange } from './comments/anchor.js';
import { CommentStore, type QuoteFn } from './comments/CommentStore.js';
import { shownRanges } from './comments/hunks.js';
import type { GitRepo } from './git/GitRepo.js';
import { resolveMode } from './mode.js';
import { Snapshotter } from './Snapshotter.js';
import type { WatchTarget } from './Watcher.js';

/** What the session needs from a watcher. `Watcher` satisfies it; tests inject fakes. */
export interface WatcherLike {
  on(event: 'dirty', listener: () => void): unknown;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface Broadcaster {
  broadcast(msg: ServerMessage): void;
}

interface Active {
  mode: ModeSpec;
  snapshotter: Snapshotter;
  comments: CommentStore;
  watcher: WatcherLike | null;
}

export interface SessionOptions {
  watch: boolean;
  /** Context lines for patches: `--context`, else the user config. Changed at runtime via setContext(). */
  context: number;
  /** Replaces the chokidar-backed Watcher. Test seam. */
  createWatcher?: (target: WatchTarget) => WatcherLike;
}

/**
 * Owns the current mode and everything derived from it. Every mutation of the
 * active state (mode transition, refresh, context change) runs through one
 * queue, one at a time, in request order: the last mode the user requested ends
 * up active with the only live watcher, a snapshot version is allocated only
 * while its task holds the queue, so published versions are monotonic and the
 * active snapshotter always carries the session's context. Requests that arrive
 * before the first mode resolves await `ready()`.
 */
export class Session {
  private active: Active | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** The refresh waiting for the queue, if any. Later requests join it. */
  private queuedRefresh: Promise<void> | null = null;
  private readable = new WeakMap<Snapshot, ReadablePaths>();
  private snapshotListeners = new Set<(snap: Snapshot) => void>();

  constructor(
    readonly repo: GitRepo,
    private readonly hub: Broadcaster,
    private readonly opts: SessionOptions,
  ) {
    this.readyPromise = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    this.readyPromise.catch(() => {});
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  get mode(): ModeSpec {
    return this.require().mode;
  }

  get snapshotter(): Snapshotter {
    return this.require().snapshotter;
  }

  get comments(): CommentStore {
    return this.require().comments;
  }

  /** Context lines the session generates patches with. */
  get context(): number {
    return this.opts.context;
  }

  /**
   * Runs after every snapshot the session produces: the first mode, a switch, a
   * refresh, a context change. In-process consumers (the LSP bridge) use this;
   * clients get the `snapshot` broadcast. Listener errors are logged, not thrown.
   */
  onSnapshot(listener: (snap: Snapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  private announce(snap: Snapshot): void {
    for (const l of this.snapshotListeners) {
      try {
        l(snap);
      } catch (e) {
        console.error('[diffle] snapshot listener failed:', e);
      }
    }
  }

  /** First mode. Rejects `ready()` on failure so early requests error out. */
  async start(req: ModeRequest): Promise<Snapshot> {
    try {
      const snap = await this.enter(req);
      this.resolveReady();
      return snap;
    } catch (e) {
      this.rejectReady(e);
      throw e;
    }
  }

  /** Switch modes at runtime. Broadcasts a snapshot bump on success. */
  async switchMode(req: ModeRequest): Promise<Snapshot> {
    const snap = await this.enter(req);
    this.hub.broadcast({ type: 'snapshot', version: snap.version });
    return snap;
  }

  /**
   * Runs `fn` after every earlier mutation settled. The only way to touch
   * `active`, `version` or `opts.context`.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.queue.then(fn);
    this.queue = r.catch(() => {});
    return r;
  }

  private enter(req: ModeRequest): Promise<Snapshot> {
    return this.run(() => this.transition(req));
  }

  private async transition(req: ModeRequest): Promise<Snapshot> {
    const mode = await resolveMode(req, this.repo);
    const snapshotter = new Snapshotter(this.repo, mode, ++this.version, this.opts.context);
    // Both awaited together: if one fails, the other's rejection is still handled.
    const [comments, snap] = await Promise.all([
      CommentStore.open(this.repo.gitDir, mode.commentKey),
      snapshotter.current(),
    ]);
    // Build the complete next state, then swap it in and retire the previous one.
    const next: Active = { mode, snapshotter, comments, watcher: null };
    // The repository may have moved on while no server was watching it.
    await this.relocateComments(next, snap);
    if (this.opts.watch && mode.live !== 'none') next.watcher = await this.startWatcher(next);
    const prev = this.active;
    this.active = next;
    await prev?.watcher?.close();
    this.announce(snap);
    return snap;
  }

  /** Change context lines for the running session; clients refetch patches. */
  setContext(context: number): Promise<void> {
    return this.run(async () => {
      if (context === this.opts.context) return;
      this.opts.context = context;
      const a = this.active;
      if (!a) return;
      a.snapshotter.setContext(context, ++this.version);
      await this.publish(a);
    });
  }

  /**
   * Recompute the active snapshot and re-anchor comments against it. At most
   * one refresh waits behind the running one: a burst of writes yields two
   * recomputes, not one per write, and the second sees all of them.
   */
  refresh(): Promise<void> {
    if (this.queuedRefresh) return this.queuedRefresh;
    const r = this.run(async () => {
      this.queuedRefresh = null;
      const a = this.require();
      a.snapshotter.invalidate(++this.version);
      await this.publish(a);
    }).catch((e) => console.error('[diffle] refresh failed:', e));
    this.queuedRefresh = r;
    return r;
  }

  /**
   * Computes `a`'s current snapshot, re-anchors its threads (hunks may have
   * grown, shrunk or moved), then broadcasts and announces it.
   */
  private async publish(a: Active): Promise<void> {
    const snap = await a.snapshotter.current();
    await this.relocateComments(a, snap);
    this.hub.broadcast({ type: 'snapshot', version: snap.version });
    this.announce(snap);
  }

  /**
   * Re-anchors threads against what `snap` shows. A changed file shows its
   * hunks; an unchanged tree file shows its new side whole (the file view) and
   * nothing of its old side.
   */
  private async relocateComments(a: Active, snap: Snapshot): Promise<void> {
    await a.comments.relocateAll(async (path, side) => {
      const buf = await this.readSide(snap, path, side);
      if (buf == null) return null;
      const contents = buf.toString('utf8');
      if (!snap.changed.some((f) => f.path === path)) return side === 'new' ? { contents, shown: null } : null;
      const patch = await a.snapshotter.patch(path);
      return { contents, shown: shownRanges(patch ?? '', side) };
    });
  }

  /**
   * Reads a file on one side of a snapshot. `path` is a snapshot path, i.e. a
   * changed file's new path or any tree path; the old side of a rename is
   * resolved to its old path here. Anything outside the snapshot (ignored
   * files, `.git`, traversal) reads as absent.
   */
  readSide(snap: Snapshot, path: string, side: Side): Promise<Buffer | null> {
    const target = sidePath(this.readablePaths(snap), path, side);
    if (target == null) return Promise.resolve(null);
    if (side === 'new') {
      return snap.newSha === 'worktree' ? this.repo.readWorktree(target) : this.repo.show(snap.newSha, target);
    }
    return this.repo.show(snap.oldSha, target);
  }

  /** Whether `readSide` would find `path` on `side`: the allowlist alone, no read. */
  hasSide(snap: Snapshot, path: string, side: Side): boolean {
    return sidePath(this.readablePaths(snap), path, side) != null;
  }

  /**
   * Quotes a line range from the current snapshot, for imports that carry no
   * `quoted`. Goes through `readSide`, so the allowlist applies.
   */
  quoter(): QuoteFn {
    return async (path, side, startLine, endLine) => {
      const snap = await this.snapshotter.current();
      const buf = await this.readSide(snap, path, side);
      return buf == null ? null : quoteRange(buf.toString('utf8'), startLine, endLine);
    };
  }

  private readablePaths(snap: Snapshot): ReadablePaths {
    let r = this.readable.get(snap);
    if (!r) {
      r = readablePaths(snap);
      this.readable.set(snap, r);
    }
    return r;
  }

  private async startWatcher(a: Active): Promise<WatcherLike> {
    const create = this.opts.createWatcher ?? (await defaultWatcherFactory());
    let ignored: ReadonlySet<string> = new Set();
    const refreshIgnored = async () => {
      ignored = new Set(await this.repo.ignoredPaths());
    };
    let watcher: WatcherLike;
    if (a.mode.live === 'worktree') {
      await refreshIgnored();
      watcher = create({
        kind: 'worktree',
        root: this.repo.root,
        gitDir: this.repo.gitDir,
        commonDir: this.repo.commonDir,
        ignored: () => ignored,
      });
    } else {
      watcher = create({ kind: 'refs', gitDir: this.repo.gitDir, commonDir: this.repo.commonDir });
    }
    watcher.on('dirty', () => {
      if (this.active !== a) return;
      void this.refresh();
      // Keep the follow-up in the queue so close() waits for its git process too.
      void this.run(async () => {
        if (this.active === a && a.mode.live === 'worktree') await refreshIgnored();
      }).catch((e) => console.error('[diffle] ignored paths refresh failed:', e));
    });
    await watcher.start();
    return watcher;
  }

  async close(): Promise<void> {
    await this.queue;
    await this.active?.watcher?.close();
  }

  private require(): Active {
    if (!this.active) throw new Error('session not ready');
    return this.active;
  }
}

async function defaultWatcherFactory(): Promise<(target: WatchTarget) => WatcherLike> {
  const { Watcher } = await import('./Watcher.js');
  return (target) => new Watcher(target);
}

interface ReadablePaths {
  /** Every path on the new side. */
  tree: Set<string>;
  /** Changed files by new path. */
  changed: Map<string, { oldPath?: string }>;
  /** Old paths of renames and copies. */
  oldPaths: Set<string>;
}

export function readablePaths(snap: Snapshot): ReadablePaths {
  const changed = new Map<string, { oldPath?: string }>();
  const oldPaths = new Set<string>();
  for (const f of snap.changed) {
    changed.set(f.path, { oldPath: f.oldPath });
    if (f.oldPath) oldPaths.add(f.oldPath);
  }
  return { tree: new Set(snap.tree), changed, oldPaths };
}

/**
 * The path to read on `side` for a snapshot path, or null when the snapshot
 * does not expose it. New side: tree paths only. Old side: a changed file's
 * old path (renames map new → old), plus tree paths and rename sources.
 */
export function sidePath(r: ReadablePaths, path: string, side: Side): string | null {
  if (side === 'new') return r.tree.has(path) ? path : null;
  const f = r.changed.get(path);
  if (f) return f.oldPath ?? path;
  return r.tree.has(path) || r.oldPaths.has(path) ? path : null;
}
