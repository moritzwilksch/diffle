import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '../persist.js';
import type {
  CommentAnchor,
  CommentMessage,
  CommentThread,
  ReplyCreate,
  Side,
  ThreadCreate,
  ThreadQuery,
  ViewedEntry,
} from '../../shared/protocol.js';
import { compareThreads, relocate } from './anchor.js';
import { isShown, type LineRange } from './hunks.js';
import { isDuplicate } from './import.js';

interface SetData {
  threads: CommentThread[];
  viewed: ViewedEntry[];
}

interface StoreFile {
  version: 2;
  sets: Record<string, Partial<SetData>>;
}

/** v1 on disk: flat comments, one anchor each. Read only to migrate. */
interface V1Comment {
  id: string;
  anchor: CommentAnchor;
  body: string;
  createdAt: number;
  updatedAt: number;
  stale: boolean;
  staleFromLine?: number;
}
interface V1File {
  version: 1;
  sets: Record<string, Partial<{ comments: V1Comment[]; viewed: ViewedEntry[] }>>;
}

/** Resolves the exact text of a range on one side, for `quoted`. Null when the range cannot be read. */
export type QuoteFn = (path: string, side: Side, startLine: number, endLine: number) => Promise<string | null>;

export class NotFoundError extends Error {}

/** A range the snapshot cannot quote: path absent on that side, or lines past the end. */
export class UnquotableError extends Error {}

/** One side of a file as the review presents it. */
export interface SideView {
  contents: string;
  /** Line ranges on display (a diff's hunks); null when the whole side is shown. */
  shown: LineRange[] | null;
}

/** Viewed marks kept per path: the current one plus the newest previous, so `restale` is derivable. */
const VIEWED_HISTORY = 2;

/**
 * Owns this mode's set in `<gitDir>/diffle/comments.json`: threads and viewed
 * marks under `sets[key]`. Nothing is cached: every read parses the file, and
 * every mutation is a read-modify-write of fresh disk state under
 * `comments.json.lock`, touching only its own key. So any number of stores on
 * one file (two servers on one repository, an old-mode store still finishing a
 * write while its replacement starts) see and keep each other's writes.
 */
export class CommentStore {
  private constructor(
    readonly file: string,
    readonly key: string,
  ) {}

  /** Opens the store; a v1 file is backed up to `comments.v1.bak` and rewritten as v2 first. */
  static async open(gitDir: string, modeKey: string): Promise<CommentStore> {
    const file = join(gitDir, 'diffle', 'comments.json');
    await withFileLock(file, async () => {
      const all = await readStoreFile(file);
      if (all.version !== 1) return;
      await copyFile(file, join(gitDir, 'diffle', 'comments.v1.bak'));
      await writeStoreFile(file, migrateV1(all));
    });
    return new CommentStore(file, modeKey);
  }

  /** Threads matching `q`; default every thread, ordered by path, line, then creation. */
  threads(q: ThreadQuery = {}): CommentThread[] {
    const state = q.state ?? 'all';
    return this.read().threads
      .filter((t) => {
        if (state === 'open' && t.resolved) return false;
        if (state === 'resolved' && !t.resolved) return false;
        if (q.author && t.messages[0]?.author !== q.author) return false;
        if (q.path != null && t.anchor.path !== q.path) return false;
        return true;
      })
      .sort(compareThreads);
  }

  get(id: string): CommentThread | undefined {
    return this.read().threads.find((t) => t.id === id);
  }

  addThread(anchor: CommentAnchor, msg: Omit<CommentMessage, 'id' | 'createdAt' | 'updatedAt'>): Promise<CommentThread> {
    return this.mutate((set) => {
      const t: CommentThread = { id: randomUUID(), anchor, messages: [newMessage(msg)], resolved: false, stale: false };
      set.threads.push(t);
      return t;
    });
  }

  reply(threadId: string, msg: ReplyCreate): Promise<CommentThread> {
    return this.mutate((set) => {
      const t = findThread(set, threadId);
      t.messages.push(newMessage({ author: msg.author ?? 'human', authorName: msg.authorName, body: msg.body }));
      return t;
    });
  }

  editMessage(threadId: string, messageId: string, body: string): Promise<CommentThread> {
    return this.mutate((set) => {
      const t = findThread(set, threadId);
      const m = t.messages.find((x) => x.id === messageId);
      if (!m) throw new NotFoundError(messageId);
      m.body = body;
      m.updatedAt = Date.now();
      return t;
    });
  }

  /** Removes the message; removes the thread when its last message goes (returns null then). */
  removeMessage(threadId: string, messageId: string): Promise<CommentThread | null> {
    return this.mutate((set) => {
      const t = findThread(set, threadId);
      const before = t.messages.length;
      t.messages = t.messages.filter((x) => x.id !== messageId);
      if (t.messages.length === before) throw new NotFoundError(messageId);
      if (t.messages.length > 0) return t;
      set.threads = set.threads.filter((x) => x.id !== threadId);
      return null;
    });
  }

  setResolved(threadId: string, resolved: boolean): Promise<CommentThread> {
    return this.mutate((set) => {
      const t = findThread(set, threadId);
      t.resolved = resolved;
      if (resolved) t.resolvedAt = Date.now();
      else delete t.resolvedAt;
      return t;
    });
  }

  removeThread(id: string): Promise<void> {
    return this.mutate((set) => {
      const before = set.threads.length;
      set.threads = set.threads.filter((t) => t.id !== id);
      if (set.threads.length === before) throw new NotFoundError(id);
    });
  }

  /**
   * Adds each import that is not already an open duplicate. Every range is
   * checked against the snapshot through `quote`; a payload's own `quoted` (the
   * text the browser showed) is kept once the range is known to exist. Throws
   * UnquotableError, adding nothing, when any range cannot be read.
   */
  importThreads(imports: ThreadCreate[], quote: QuoteFn): Promise<{ added: CommentThread[]; skipped: number }> {
    return this.mutate(
      async (set) => {
        const added: CommentThread[] = [];
        const pending: Array<{ anchor: CommentAnchor; t: ThreadCreate }> = [];
        let skipped = 0;
        const existing = [...set.threads];
        for (const t of imports) {
          if (isDuplicate(existing, t)) {
            skipped++;
            continue;
          }
          const side = t.side ?? 'new';
          const startLine = t.startLine;
          const endLine = t.endLine ?? startLine;
          const fromSnapshot = await quote(t.path, side, startLine, endLine);
          if (fromSnapshot == null) throw new UnquotableError(`cannot quote ${t.path}:${startLine}${endLine !== startLine ? `-${endLine}` : ''} on the ${side} side`);
          const anchor: CommentAnchor = { path: t.path, side, startLine, endLine, quoted: t.quoted ?? fromSnapshot };
          pending.push({ anchor, t });
          // Later imports in the same batch may duplicate this one.
          existing.push({ id: '', anchor, messages: [{ id: '', author: t.author ?? 'human', body: t.body, createdAt: 0, updatedAt: 0 }], resolved: false, stale: false });
        }
        for (const { anchor, t } of pending) {
          const thread: CommentThread = {
            id: randomUUID(),
            anchor,
            messages: [newMessage({ author: t.author ?? 'human', authorName: t.authorName, body: t.body })],
            resolved: false,
            stale: false,
          };
          set.threads.push(thread);
          added.push(thread);
        }
        return { added, skipped };
      },
      (r) => r.added.length > 0,
    );
  }

  clear(): Promise<void> {
    return this.mutate((set) => {
      set.threads = [];
    });
  }

  /** Drop every stale thread. Returns how many went. */
  removeStale(): Promise<number> {
    return this.mutate(
      (set) => {
        const keep = set.threads.filter((t) => !t.stale);
        const n = set.threads.length - keep.length;
        set.threads = keep;
        return n;
      },
      (n) => n > 0,
    );
  }

  viewed(): ViewedEntry[] {
    return this.read().viewed;
  }

  /**
   * Mark or unmark a path as viewed at a given new-side blob. The newest previous
   * entry for the path is kept so a later blob can be recognised as re-touched.
   */
  setViewed(path: string, blob: string, viewed: boolean): Promise<ViewedEntry[]> {
    return this.mutate((set) => {
      const others = set.viewed.filter((v) => v.path !== path);
      const history = set.viewed.filter((v) => v.path === path && v.blob !== blob).slice(-(VIEWED_HISTORY - 1));
      set.viewed = [...others, ...history, { path, blob, viewed }];
      return set.viewed;
    });
  }

  /** Replace marks for many paths at once; their history is dropped. */
  setViewedMany(entries: ViewedEntry[]): Promise<ViewedEntry[]> {
    return this.mutate((set) => {
      const paths = new Set(entries.map((e) => e.path));
      set.viewed = [...set.viewed.filter((v) => !paths.has(v.path)), ...entries];
      return set.viewed;
    });
  }

  /**
   * Re-anchor every thread against the current review. A thread is stale when
   * its side is gone, its text is not found, or the relocated range falls
   * outside what the review shows. Returns true if anything changed.
   */
  async relocateAll(view: (path: string, side: Side) => Promise<SideView | null>): Promise<boolean> {
    const cache = new Map<string, Promise<SideView | null>>();
    const load = (path: string, side: Side) => {
      const k = `${side}:${path}`;
      let p = cache.get(k);
      if (!p) {
        p = view(path, side);
        cache.set(k, p);
      }
      return p;
    };
    // Under the lock: a thread added or moved by another store meanwhile is re-anchored too, never clobbered.
    return this.mutate(
      async (set) => {
        let changed = false;
        for (const t of set.threads) {
          const v = await load(t.anchor.path, t.anchor.side);
          let moved = v == null ? null : relocate(t.anchor, v.contents);
          if (moved && v?.shown && !isShown(v.shown, moved.startLine, moved.endLine)) moved = null;
          if (moved == null) {
            if (!t.stale) {
              t.stale = true;
              t.staleFromLine = t.anchor.startLine;
              changed = true;
            }
            continue;
          }
          if (t.stale) {
            t.stale = false;
            delete t.staleFromLine;
            changed = true;
          }
          if (moved.startLine !== t.anchor.startLine || moved.endLine !== t.anchor.endLine) {
            t.anchor = moved;
            changed = true;
          }
        }
        return changed;
      },
      (changed) => changed,
    );
  }

  /** This key's set as on disk right now; empty when the file is absent. Malformed JSON propagates. */
  private read(): SetData {
    let parsed: StoreFile | V1File;
    try {
      parsed = parseStoreFile(readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return { threads: [], viewed: [] };
    }
    return ownSet(parsed.version === 2 ? parsed : migrateV1(parsed), this.key);
  }

  /**
   * Locked read-modify-write: `fn` edits this key's set as read from disk under
   * the lock, other keys pass through untouched, and the file is rewritten when
   * `changed(result)` holds. A throwing `fn` writes nothing. A failed write
   * rejects for its caller only; the next mutation still reaches disk.
   */
  private mutate<R>(fn: (set: SetData) => R | Promise<R>, changed: (r: R) => boolean = () => true): Promise<R> {
    return withFileLock(this.file, async () => {
      const onDisk = await readStoreFile(this.file);
      const all = onDisk.version === 2 ? onDisk : migrateV1(onDisk);
      const set = ownSet(all, this.key);
      const r = await fn(set);
      if (changed(r)) await writeStoreFile(this.file, { version: 2, sets: { ...all.sets, [this.key]: set } });
      return r;
    });
  }
}

function ownSet(all: StoreFile, key: string): SetData {
  const set = all.sets[key] ?? {};
  return { threads: set.threads ?? [], viewed: set.viewed ?? [] };
}

function findThread(set: SetData, id: string): CommentThread {
  const t = set.threads.find((x) => x.id === id);
  if (!t) throw new NotFoundError(id);
  return t;
}

/** The file as stored, or an empty v2 store when absent. Malformed JSON propagates. */
async function readStoreFile(file: string): Promise<StoreFile | V1File> {
  try {
    return parseStoreFile(await readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return { version: 2, sets: {} };
}

/** Unknown shapes read as an empty v2 store. */
function parseStoreFile(text: string): StoreFile | V1File {
  const parsed = JSON.parse(text) as Partial<StoreFile> | Partial<V1File>;
  if (parsed.version === 2 && parsed.sets) return parsed as StoreFile;
  if (parsed.version === 1 && parsed.sets) return parsed as V1File;
  return { version: 2, sets: {} };
}

/** Atomic write. Quoted source lines: owner-only. */
function writeStoreFile(file: string, data: StoreFile): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(data, null, 2), 0o600);
}

function newMessage(msg: Omit<CommentMessage, 'id' | 'createdAt' | 'updatedAt'>): CommentMessage {
  const now = Date.now();
  const m: CommentMessage = { id: randomUUID(), author: msg.author, body: msg.body, createdAt: now, updatedAt: now };
  if (msg.authorName) m.authorName = msg.authorName;
  return m;
}

/** Each v1 comment becomes a single-message, unresolved human thread. */
function migrateV1(v1: V1File): StoreFile {
  const sets: StoreFile['sets'] = {};
  for (const [key, set] of Object.entries(v1.sets)) {
    sets[key] = {
      threads: (set.comments ?? []).map((c) => ({
        id: c.id,
        anchor: c.anchor,
        messages: [{ id: randomUUID(), author: 'human', body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt }],
        resolved: false,
        stale: c.stale,
        ...(c.staleFromLine != null ? { staleFromLine: c.staleFromLine } : {}),
      })),
      viewed: set.viewed ?? [],
    };
  }
  return { version: 2, sets };
}
