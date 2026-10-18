import { languageOf } from '../../shared/protocol.js';
import type { JsonRpcConnection } from './JsonRpc.js';
import { LspUnavailableError } from './LspProcess.js';

export interface DocumentsOptions {
  /** The server once initialized; rejects with LspUnavailableError when it is gone. */
  connection: () => Promise<JsonRpcConnection>;
  /** New-side text of a snapshot path, or null when the snapshot does not expose it. */
  read: (path: string) => Promise<string | null>;
  /** The document URI the server knows a snapshot path by. */
  uri: (path: string) => string;
  /** Most documents kept open beyond the tracked set; the least recently used is closed first. Default MAX_UNTRACKED_OPEN. */
  maxOpen?: number;
}

/**
 * Navigation opens whatever file a query lands in. Without a cap every path
 * visited in a long review stays open in the server, growing its memory and
 * per-save recheck cost.
 */
const MAX_UNTRACKED_OPEN = 64;

/**
 * The documents one server has open, kept in step with the snapshot: the diff's own files
 * for as long as they are in it, and the files queries land in until they fall off the
 * least-recently-used end. Sends `didOpen`, `didChange` and `didClose`; nothing else.
 */
export class Documents {
  /** Open documents, least recently synced first. */
  private open = new Map<string, { version: number; text: string }>();
  /** Syncs in flight by path, so a track pass and a query racing on one file send a single didOpen. */
  private syncing = new Map<string, Promise<void>>();
  /** Paths `track` opened on the snapshot's behalf; closed again when they leave the snapshot. */
  private tracked = new Set<string>();
  private tracking: Promise<void> = Promise.resolve();

  constructor(private readonly opts: DocumentsOptions) {}

  /** The text the server holds for an open path. */
  textOf(path: string): string | undefined {
    return this.open.get(path)?.text;
  }

  /**
   * Opens or updates the document so the server sees the snapshot's text before a
   * request. Concurrent syncs of one path share a single read and notification.
   * Untracked documents beyond `maxOpen` are closed, least recently used first;
   * tracked ones stay open for the snapshot's lifetime.
   */
  sync(path: string): Promise<void> {
    let pending = this.syncing.get(path);
    if (!pending) {
      pending = this.syncNow(path).finally(() => this.syncing.delete(path));
      this.syncing.set(path, pending);
    }
    return pending;
  }

  /**
   * Keeps the diff's own files open in the server with their snapshot text.
   * Servers index the workspace lazily and cap how much of it they index
   * (pyrefly: in the background from the first open, 2000 files), so a
   * reference in a changed file that nobody queried yet is otherwise only found
   * once its file happens to be indexed, and from the text on disk. Opening
   * everything at start also warms the index before the first query. Calls are
   * serialized; the last set wins. Never throws: a path the snapshot cannot read
   * is skipped.
   */
  track(paths: string[]): Promise<void> {
    const run = this.tracking.then(() => this.trackNow(paths)).catch(() => {});
    this.tracking = run;
    return run;
  }

  private async trackNow(paths: string[]): Promise<void> {
    const rpc = await this.opts.connection();
    const next = new Set(paths);
    for (const path of this.tracked) {
      if (next.has(path)) continue;
      this.tracked.delete(path);
      if (this.open.delete(path)) rpc.notify('textDocument/didClose', { textDocument: { uri: this.opts.uri(path) } });
    }
    for (const path of next) {
      try {
        await this.sync(path);
        this.tracked.add(path);
      } catch (e) {
        if (e instanceof LspUnavailableError) return;
        /* not readable on the new side (deleted, binary, gone between snapshot and read): nothing to open */
      }
    }
  }

  private async syncNow(path: string): Promise<void> {
    const rpc = await this.opts.connection();
    const text = await this.opts.read(path);
    if (text == null) throw new Error(`${path} is not in the snapshot`);
    const uri = this.opts.uri(path);
    const doc = this.open.get(path);
    if (!doc) {
      this.open.set(path, { version: 1, text });
      rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageOf(path) ?? 'plaintext', version: 1, text },
      });
    } else {
      // Re-insert to mark it most recently used.
      this.open.delete(path);
      this.open.set(path, doc);
      if (doc.text !== text) {
        doc.version += 1;
        doc.text = text;
        rpc.notify('textDocument/didChange', {
          textDocument: { uri, version: doc.version },
          contentChanges: [{ text }],
        });
      }
    }
    this.evict(rpc);
  }

  /** Closes the least recently used untracked documents until at most `maxOpen` remain. */
  private evict(rpc: JsonRpcConnection): void {
    const max = this.opts.maxOpen ?? MAX_UNTRACKED_OPEN;
    let untracked = 0;
    for (const path of this.open.keys()) if (!this.tracked.has(path)) untracked++;
    for (const path of this.open.keys()) {
      if (untracked <= max) return;
      if (this.tracked.has(path) || this.syncing.has(path)) continue;
      this.open.delete(path);
      untracked--;
      rpc.notify('textDocument/didClose', { textDocument: { uri: this.opts.uri(path) } });
    }
  }
}
