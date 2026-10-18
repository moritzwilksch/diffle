import { realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LspLocation } from '../../shared/protocol.js';
import { mapLimit } from '../concurrency.js';
import { fileLinkUris } from './hover.js';

export interface LocatorOptions {
  /** Repository root, as the server was given it. */
  root: string;
  /** New-side text of a snapshot path, or null when the snapshot does not expose it. */
  read: (path: string) => Promise<string | null>;
  /** Whether the snapshot exposes a path on its new side. Membership only: no content is read. */
  has: (path: string) => Promise<boolean>;
  /** The text the server holds for an open path, which saves a read. */
  textOf: (path: string) => string | undefined;
}

/** LSP wire range, only the fields read here. */
export interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Concurrent snapshot reads while mapping a result set back to paths. */
const READ_CONCURRENCY = 8;
/** Files outside the snapshot remembered for `readExternal`; the least recently named is forgotten first. */
const MAX_EXTERNAL = 1024;

/**
 * Maps the URIs a language server answers with back to snapshot paths, and remembers
 * the files outside the snapshot it named, so `/api/file` may serve those and nothing
 * else beyond the allowlist.
 */
export class Locator {
  /** Symlink-free root; servers often canonicalize, so URIs may not share the root's spelling. */
  private readonly realRoot: string;
  /** Absolute paths of files outside the snapshot that results named, least recently first. */
  private external = new Set<string>();

  constructor(private readonly opts: LocatorOptions) {
    this.realRoot = safeRealpathSync(opts.root);
  }

  /**
   * Repo-relative path for a file URI inside the root; null otherwise. Compares
   * lexically first, then by realpath, so a canonicalized URI still matches a
   * root reached through a symlink (and vice versa).
   */
  async pathOf(uri: string): Promise<string | null> {
    let abs: string;
    try {
      abs = fileURLToPath(uri);
    } catch {
      return null;
    }
    const lexical = relativeInside(this.opts.root, abs);
    if (lexical != null) return lexical;
    const real = await realpath(abs).catch(() => null);
    if (real == null) return null;
    return relativeInside(this.realRoot, real);
  }

  /**
   * Server locations as paths with the text of each line: a snapshot path, or, for a
   * file the snapshot lacks (stdlib, site-packages, an ignored venv), the file itself
   * read from disk and marked external. Each distinct URI is read once, in parallel
   * with a limit, so a large reference set costs a bounded number of reads. A file
   * readable neither way is dropped.
   */
  async locations(locs: { uri: string; range: Range }[]): Promise<LspLocation[]> {
    const uris = [...new Set(locs.map((l) => l.uri))];
    const found = await mapLimit(uris, READ_CONCURRENCY, (uri) => this.locate(uri));
    const byUri = new Map(uris.map((uri, i) => [uri, found[i]!]));
    const out: LspLocation[] = [];
    for (const l of locs) {
      const f = byUri.get(l.uri);
      if (!f) continue;
      const line = l.range.start.line + 1;
      const loc: LspLocation = { path: f.path, line, col: l.range.start.character, text: lineAt(f.text, line) };
      if (f.external) loc.external = true;
      out.push(loc);
    }
    return out;
  }

  /**
   * Where each `file:` link in hover text points inside the repository: the repo-relative path and,
   * from the URI's `#line` or `#line,col` fragment, the 1-based line. Links outside the root are
   * left out, so the client never offers a jump it cannot make.
   */
  async links(md: string): Promise<Map<string, { path: string; line?: number }>> {
    const uris = fileLinkUris(md);
    const out = new Map<string, { path: string; line?: number }>();
    await Promise.all(
      uris.map(async (uri) => {
        const hash = uri.indexOf('#');
        const path = await this.pathOf(hash === -1 ? uri : uri.slice(0, hash));
        if (path == null) return;
        // Both fragment shapes servers write: `#12` / `#12,7` (pyright) and `#L12`.
        const line = hash === -1 ? null : /^L?(\d+)/.exec(uri.slice(hash + 1))?.[1];
        out.set(uri, line == null ? { path } : { path, line: Number(line) });
      }),
    );
    return out;
  }

  /** `has` for each distinct path, in parallel. */
  async membership(paths: (string | null)[]): Promise<Map<string, boolean>> {
    const distinct = [...new Set(paths.filter((p): p is string => p != null))];
    const flags = await mapLimit(distinct, READ_CONCURRENCY, (p) => this.opts.has(p));
    return new Map(distinct.map((p, i) => [p, flags[i]!]));
  }

  /**
   * Contents of a file outside the snapshot that a recent result named as
   * `external`, read from disk; null for every other path. This is the only
   * read done on a client's behalf, so a path the language server never
   * returned stays behind the snapshot allowlist.
   */
  async readExternal(path: string): Promise<Buffer | null> {
    if (!this.external.has(path)) return null;
    return readFile(path).catch(() => null);
  }

  private async locate(uri: string): Promise<{ path: string; text: string; external: boolean } | null> {
    const path = await this.pathOf(uri);
    if (path != null) {
      const text = this.opts.textOf(path) ?? (await this.opts.read(path));
      if (text != null) return { path, text, external: false };
    }
    let abs: string;
    try {
      abs = fileURLToPath(uri);
    } catch {
      return null;
    }
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text == null) return null;
    this.remember(abs);
    return { path: abs, text, external: true };
  }

  private remember(abs: string): void {
    // Re-insert to mark it most recently named.
    this.external.delete(abs);
    this.external.add(abs);
    for (const old of this.external) {
      if (this.external.size <= MAX_EXTERNAL) break;
      this.external.delete(old);
    }
  }
}

/** `abs` relative to `root` when it lies inside it; null otherwise. */
function relativeInside(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

/**
 * Canonical `p`, or `p` itself when it cannot be resolved. Uses libuv's
 * realpath, the same one the async `realpath` in `pathOf` uses: the JS
 * `realpathSync` keeps a Windows 8.3 short name (`RUNNER~1`) that libuv
 * expands, and the two answers would never compare equal.
 */
function safeRealpathSync(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function lineAt(text: string, line: number): string {
  let start = 0;
  for (let i = 1; i < line; i++) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return '';
    start = nl + 1;
  }
  const end = text.indexOf('\n', start);
  return (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\r$/, '');
}
