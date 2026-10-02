import {
  comparisonLabel,
  imageKey,
  type GithubExportRequest,
  type GithubExportResponse,
  type EntryRequest,
  type GithubMetadata,
  type Iteration,
  MAX_RANGE_COMMITS,
  type ModeRequest,
  type ModeSpec,
  type Moved,
  type RangeCommit,
  type RangePair,
  type ServerMessage,
  type Side,
  type Snapshot,
} from '../shared/protocol.js';
import { quoteRange } from './comments/anchor.js';
import { CommentStore, type AnchorSource } from './comments/CommentStore.js';
import { shownRanges } from './comments/hunks.js';
import type { GitRepo } from './git/GitRepo.js';
import { discoverGithub } from './GithubMetadata.js';
import { type GithubClient, GithubError, NO_TOKEN } from './github/client.js';
import { GithubExporter } from './github/review.js';
import { IterationStore } from './iterations.js';
import { resolveComparison, type ResolvedReview, resolveReview } from './mode.js';
import { RevspecError } from './revspec.js';
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
  github?: { snapshot: Snapshot; expires: number; promise: Promise<GithubMetadata> };
  prUrl?: string;
  mode: ModeSpec;
  snapshotter: Snapshotter;
  comments: CommentStore;
  watcher: WatcherLike | null;
  /** Where a refs-live comparison's refs point now, when that differs from the snapshot; cleared by a reload. */
  moved: Moved | null;
}

export interface SessionOptions {
  watch: boolean;
  /** Absent: no token, so pull request lookup and export are off. */
  github?: GithubClient;
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
 *
 * A worktree-live comparison recomputes on every change. A refs-live one only
 * announces that its refs moved (`moved`) and recomputes on `reload()`, so a
 * push or rebase does not swap the review out from under the reviewer.
 */
export class Session {
  private active: Active | null = null;
  private readonly exporter = new GithubExporter();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** The refresh waiting for the queue, if any. Later requests join it. */
  private queuedRefresh: Promise<void> | null = null;
  /** The refs check waiting for the queue, if any. Later signals join it. */
  private queuedCheck: Promise<void> | null = null;
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

  /** The pending reload of a refs-live comparison, for a client that connects after the push. */
  get moved(): Moved | null {
    return this.require().moved;
  }

  /** Cached independently of snapshot construction; callers never hold the transition queue. */
  github(snap: Snapshot): Promise<GithubMetadata> {
    const active = this.require();
    if (snap.mode !== active.mode) return Promise.reject(new GithubError('Comparison changed; try again'));
    const cached = active.github;
    if (cached?.snapshot === snap && cached.expires > Date.now()) return cached.promise;
    const promise = discoverGithub(this.repo, snap, { github: this.opts.github, prUrl: active.prUrl });
    const entry = { snapshot: snap, expires: Date.now() + 30_000, promise };
    active.github = entry;
    void promise.catch(() => {
      if (active.github === entry) active.github = undefined;
    });
    return promise;
  }

  /** Validate fresh PR data inside the export queue against the current comparison. */
  exportGithub({ threadIds }: GithubExportRequest): Promise<GithubExportResponse> {
    return this.exporter.export(async () => {
      const active = this.require();
      const snap = await active.snapshotter.current();
      if (active !== this.active) throw new GithubError('Comparison changed; try again');
      const github = this.opts.github;
      if (!github) throw new GithubError(NO_TOKEN);
      const metadata = await discoverGithub(this.repo, snap, { github, prUrl: active.prUrl });
      if (!metadata.pullRequest || metadata.reason !== null)
        throw new GithubError(metadata.reason ?? 'No matching pull request');
      if (active !== this.active || snap !== (await active.snapshotter.current()))
        throw new GithubError('Comparison changed; try again');
      return {
        snap,
        pullRequest: metadata.pullRequest,
        threads: active.comments.threads({ state: 'all' }),
        threadIds,
        github,
      };
    });
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

  /**
   * Resolves a request into a review without activating it, so a caller can reject
   * invalid input before serving. Queued, so `close()` waits for a PR fetch.
   */
  resolve(req: EntryRequest): Promise<ResolvedReview> {
    return this.run(() => resolveReview(req, this.repo, this.opts.github));
  }

  /** First mode, from `resolve`. Rejects `ready()` on failure so early requests error out. */
  async start(review: ResolvedReview): Promise<Snapshot> {
    try {
      const snap = await this.run(() => this.activate(review));
      this.resolveReady();
      return snap;
    } catch (e) {
      this.rejectReady(e);
      throw e;
    }
  }

  /** Switch modes at runtime. Broadcasts a snapshot bump on success. */
  async switchMode(req: ModeRequest): Promise<Snapshot> {
    const snap = await this.run(async () =>
      this.activate(
        req.kind === 'focus'
          ? await this.focus(req.commit)
          : req.kind === 'interdiff'
            ? await this.interdiff(req.from, req.to)
            : req.kind === 'pair'
              ? await this.pair(req.commit)
              : await resolveReview(req, this.repo, this.opts.github),
      ),
    );
    this.hub.broadcast({ type: 'snapshot', version: snap.version });
    return snap;
  }

  /**
   * Focuses `commit`, by hash or short hash, of the active range's listed commits, or with null returns to
   * the range. A focused commit keeps its own comments, as when entered alone, and the range's PR identity.
   */
  private async focus(commit: string | null): Promise<ResolvedReview> {
    const a = this.require();
    const { within, ...self } = a.mode;
    if (!within && self.base === 'parent') throw new RevspecError('a single commit has no commits to focus');
    const range = within ?? self;
    if (commit === null) return { mode: range, prUrl: a.prUrl };
    const listed = (await a.snapshotter.current()).commits.list;
    const sha = listed.find((c) => c.sha === commit || c.short === commit)?.sha;
    if (!sha) throw new RevspecError(`not a listed commit of ${comparisonLabel(range)}: ${commit}`);
    return {
      prUrl: a.prUrl,
      mode: {
        old: sha,
        new: sha,
        base: 'parent',
        // The commit is pinned; refs still move the range, whose commits stay listed.
        live: range.live === 'none' ? 'none' : 'refs',
        commentKey: `commit:${sha}`,
        within: range,
      },
    };
  }

  /**
   * Compares two recorded iterations of the active range: `from`'s head replayed onto `to`'s base
   * against `to`'s head, so only what the branch itself changed in between shows. The interdiff
   * keeps its own comments and the range's PR identity; its refs keep being watched.
   */
  private async interdiff(from: number, to: number): Promise<ResolvedReview> {
    const a = this.require();
    const range = a.mode.within ?? a.mode;
    if (range.base === 'parent') throw new RevspecError('a single commit has no iterations');
    if (from >= to) throw new RevspecError('compare an older iteration with a newer one');
    const store = new IterationStore(this.repo, range.commentKey);
    const [older, newer] = await Promise.all([store.get(from), store.get(to)]);
    if (!older || !newer) throw new RevspecError(`no iteration #${older ? to : from} of ${comparisonLabel(range)}`);
    // The same base needs no replay: the older head's tree is what was reviewed.
    const [{ tree, conflicts }, pairs] = await Promise.all([
      older.oldSha === newer.oldSha
        ? this.repo.tree(older.newSha).then((tree) => ({ tree, conflicts: [] }))
        : this.repo.replay(older.oldSha, newer.oldSha, older.newSha),
      this.pairs(older, newer),
    ]);
    return {
      prUrl: a.prUrl,
      mode: {
        old: tree,
        new: newer.newSha,
        base: 'direct',
        live: range.live === 'none' ? 'none' : 'refs',
        commentKey: `${range.commentKey}:interdiff:${from}-${to}`,
        within: range,
        interdiff: { from: older, to: newer, conflicts, pairs },
      },
    };
  }

  /**
   * Pairs the two iterations' commits as `git range-diff` does and tells a pair whose patch is
   * the same (a reworded commit) from an amended one by patch id.
   */
  private async pairs(older: Iteration, newer: Iteration): Promise<RangePair[]> {
    const oldRange = `${older.oldSha}..${older.newSha}`;
    const newRange = `${newer.oldSha}..${newer.newSha}`;
    const [rows, oldCommits, newCommits] = await Promise.all([
      this.repo.rangeDiff(oldRange, newRange),
      this.repo.rangeCommits(oldRange, MAX_RANGE_COMMITS),
      this.repo.rangeCommits(newRange, MAX_RANGE_COMMITS),
    ]);
    // range-diff abbreviates; a commit beyond the listed window is looked up on its own.
    const find = async (list: RangeCommit[], abbrev: string | null): Promise<RangeCommit | null> => {
      if (abbrev === null) return null;
      const listed = list.find((c) => c.sha.startsWith(abbrev));
      return listed ?? (await this.repo.rangeCommits(`${abbrev}^!`, 1)).list[0] ?? null;
    };
    const paired = await Promise.all(
      rows.map(async (row) => ({
        old: await find(oldCommits.list, row.old),
        new: await find(newCommits.list, row.new),
        marker: row.marker,
      })),
    );
    const changed = paired.filter((p) => p.marker === '!' && p.old && p.new);
    const ids = await this.repo.patchIds(changed.flatMap((p) => [p.old!.sha, p.new!.sha]));
    return paired.map(({ old, new: next, marker }) => ({
      old,
      new: next,
      status:
        marker === '='
          ? 'identical'
          : marker === '<'
            ? 'dropped'
            : marker === '>'
              ? 'added'
              : old && next && ids.get(old.sha) !== undefined && ids.get(old.sha) === ids.get(next.sha)
                ? 'message'
                : 'changed',
    }));
  }

  /**
   * Shows one pair of the active interdiff by its new-side commit: an added commit against its
   * parent, an amended or reworded one against its old self replayed onto its parent. With null,
   * the whole interdiff again. Identical pairs have nothing to show; dropped ones have no new side.
   */
  private async pair(commit: string | null): Promise<ResolvedReview> {
    const a = this.require();
    const { interdiff, within: range } = a.mode;
    if (!interdiff || !range) throw new RevspecError('no interdiff to pick a pair from');
    if (commit === null) return this.interdiff(interdiff.from.n, interdiff.to.n);
    const found = interdiff.pairs.find((p) => p.new && (p.new.sha === commit || p.new.short === commit));
    if (!found?.new) throw new RevspecError(`not a commit of ${comparisonLabel(a.mode)}: ${commit}`);
    if (found.status === 'identical') throw new RevspecError(`${found.new.short} is identical in both iterations`);
    const live = range.live === 'none' ? 'none' : 'refs';
    const base = { live, within: range, interdiff } as const;
    if (!found.old) {
      const sha = found.new.sha;
      return {
        prUrl: a.prUrl,
        mode: {
          ...base,
          old: sha,
          new: sha,
          base: 'parent',
          commentKey: `commit:${sha}`,
          pair: { old: null, new: sha, conflicts: [] },
        },
      };
    }
    const { tree, conflicts } = await this.repo.replay(`${found.old.sha}^`, `${found.new.sha}^`, found.old.sha);
    return {
      prUrl: a.prUrl,
      mode: {
        ...base,
        old: tree,
        new: found.new.sha,
        base: 'direct',
        commentKey: `${range.commentKey}:pair:${found.old.sha}-${found.new.sha}`,
        pair: { old: found.old.sha, new: found.new.sha, conflicts },
      },
    };
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

  private async activate({ mode, prUrl }: ResolvedReview): Promise<Snapshot> {
    // A range that can move again gets its iterations recorded: one between refs, or a PR's, fetched anew each run.
    const range = mode.within ?? mode;
    const followed = range.base !== 'parent' && (range.live === 'refs' || prUrl != null);
    const snapshotter = new Snapshotter(
      this.repo,
      mode,
      ++this.version,
      this.opts.context,
      followed ? new IterationStore(this.repo, range.commentKey) : null,
    );
    // Both awaited together: if one fails, the other's rejection is still handled.
    const [comments, snap] = await Promise.all([
      CommentStore.open(this.repo.gitDir, mode.commentKey),
      snapshotter.current(),
    ]);
    // Build the complete next state, then swap it in and retire the previous one.
    const next: Active = { mode, prUrl, snapshotter, comments, watcher: null, moved: null };
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
      await this.recompute();
    }).catch((e) => console.error('[diffle] refresh failed:', e));
    this.queuedRefresh = r;
    return r;
  }

  /** The reviewer asks for the moved refs: recompute now. Unlike `refresh`, a failure is the caller's. */
  reload(): Promise<Snapshot> {
    return this.run(async () => {
      const a = this.require();
      if (!a.mode.interdiff || !a.mode.within) return this.recompute();
      // An interdiff is pinned; the moved refs belong to its range, where the reviewer continues.
      const snap = await this.activate({ mode: a.mode.within, prUrl: a.prUrl });
      this.hub.broadcast({ type: 'snapshot', version: snap.version });
      return snap;
    });
  }

  private recompute(): Promise<Snapshot> {
    const a = this.require();
    a.snapshotter.invalidate(++this.version);
    return this.publish(a);
  }

  /**
   * Computes `a`'s current snapshot, re-anchors its threads (hunks may have
   * grown, shrunk or moved), then broadcasts and announces it.
   */
  private async publish(a: Active): Promise<Snapshot> {
    const snap = await a.snapshotter.current();
    await this.relocateComments(a, snap);
    // The snapshot resolved the refs afresh; a signal arriving later compares against it.
    a.moved = null;
    this.hub.broadcast({ type: 'snapshot', version: snap.version });
    this.announce(snap);
    return snap;
  }

  /**
   * Resolves the refs the live comparison follows and tells clients when they
   * left the snapshot behind, or came back to it. At most one check waits
   * behind the running one, as with `refresh`.
   */
  private checkMoved(a: Active): Promise<void> {
    if (this.queuedCheck) return this.queuedCheck;
    const r = this.run(async () => {
      this.queuedCheck = null;
      if (this.active !== a) return;
      const snap = await a.snapshotter.current();
      const { oldSha, newSha } = await resolveComparison(this.repo, a.mode.within ?? a.mode);
      const moved =
        oldSha === snap.commits.oldSha && newSha === snap.commits.newSha
          ? null
          : { version: snap.version, oldSha, newSha };
      if (moved?.oldSha === a.moved?.oldSha && moved?.newSha === a.moved?.newSha) return;
      a.moved = moved;
      this.hub.broadcast({ type: 'moved', moved });
    }).catch((e) => console.error('[diffle] refs check failed:', e));
    this.queuedCheck = r;
    return r;
  }

  /**
   * Re-anchors threads against what `snap` shows. A changed file shows its
   * hunks; an unchanged tree file shows its new side whole (the file view) and
   * nothing of its old side. A file thread only needs its file in the review.
   */
  private async relocateComments(a: Active, snap: Snapshot): Promise<void> {
    await a.comments.relocateAll({
      side: async (path, side) => {
        const buf = await this.readSide(snap, path, side);
        if (buf == null) return null;
        const contents = buf.toString('utf8');
        if (!snap.changed.some((f) => f.path === path)) return side === 'new' ? { contents, shown: null } : null;
        const patch = await a.snapshotter.patch(path);
        return { contents, shown: shownRanges(patch ?? '', side) };
      },
      hasFile: (path) => this.hasFile(snap, path),
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
    return snap.oldSha === 'worktree' ? this.repo.readWorktree(target) : this.repo.show(snap.oldSha, target);
  }

  /**
   * The bytes `key` names on one side of `path`, or null unless `key` is that side's `imageKey` in `snap`.
   * A worktree file that changed since `snap` reads as null too, so a key never serves other bytes.
   */
  async readImage(snap: Snapshot, path: string, side: Side, key: string): Promise<Buffer | null> {
    if (key !== imageKey(snap, path, side)) return null;
    // An unchanged path's key is a commit: read that commit, not a worktree that may have moved on.
    if (!snap.changed.some((f) => f.path === path))
      return this.readSide(snap, path, key === snap.newSha ? 'new' : 'old');
    const buf = await this.readSide(snap, path, side);
    if (buf == null || (side === 'new' ? snap.newSha : snap.oldSha) !== 'worktree') return buf;
    // The file may have changed since `snap`: serve it only while it still hashes to the key.
    const target = sidePath(this.readablePaths(snap), path, side);
    return target != null && (await this.repo.hashObject(buf, target)) === key ? buf : null;
  }

  /** Whether `readSide` would find `path` on `side`: the allowlist alone, no read. */
  hasSide(snap: Snapshot, path: string, side: Side): boolean {
    return sidePath(this.readablePaths(snap), path, side) != null;
  }

  /** Whether `path` is a file of the review: a changed file (by its new path) or a tree path. A rename's old path is not. */
  hasFile(snap: Snapshot, path: string): boolean {
    const r = this.readablePaths(snap);
    return r.tree.has(path) || r.changed.has(path);
  }

  /**
   * Places imported anchors against the current snapshot: quotes a line range for
   * imports that carry no `quoted`, and says whether a file thread's file is in the
   * review. Goes through `readSide`, so the allowlist applies.
   */
  anchorSource(): AnchorSource {
    return {
      quote: async (path, side, startLine, endLine) => {
        const snap = await this.snapshotter.current();
        const buf = await this.readSide(snap, path, side);
        return buf == null ? null : quoteRange(buf.toString('utf8'), startLine, endLine);
      },
      hasFile: async (path) => this.hasFile(await this.snapshotter.current(), path),
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
      if (a.mode.live !== 'worktree') {
        void this.checkMoved(a);
        return;
      }
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
