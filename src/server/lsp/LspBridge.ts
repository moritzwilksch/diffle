import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LspFeature,
  LspHoverResponse,
  LspLocationsResponse,
  LspLogEntry,
  LspOccurrencesResponse,
  LspPosition,
  LspProcessStatus,
  LspSymbol,
  LspSymbolsResponse,
} from '@/shared/protocol.js';
import { LSP_FEATURE_LABELS } from '@/shared/lsp.js';
import type { LspSettings } from './configuration.js';
import { Documents } from './Documents.js';
import { hoverMarkdown, localizeFileLinks, type HoverContents } from './hover.js';
import { JsonRpcError } from './JsonRpc.js';
import { Locator, type Range } from './Locator.js';
import { LspProcess, LspUnavailableError, LspUnsupportedError, type LspProcessOptions } from './LspProcess.js';
import {
  type DocumentHighlight,
  type DocumentSymbol,
  type Location,
  type LocationLink,
  type SymbolInformation,
  flattenSymbols,
  fromLsp,
  inconclusive,
  normalizeLocations,
  symbolInformation,
  toLsp,
} from './shapes.js';

export interface LspBridgeOptions extends LspProcessOptions {
  /** New-side text of a snapshot path, or null when the snapshot does not expose it. */
  read: (path: string) => Promise<string | null>;
  /** Whether the snapshot exposes a path on its new side. Membership only: no content is read. */
  has: (path: string) => Promise<boolean>;
  /** Most documents kept open beyond the tracked set. */
  maxOpen?: number;
}

/** LSP `ContentModified`: the document moved under the request, so the answer would be stale. */
const CONTENT_MODIFIED = -32801;
/** Waits before re-asking a request the server refused as stale, one per attempt. */
const CONTENT_MODIFIED_BACKOFF_MS = [40, 120];

/**
 * One language server as diffle asks it: each LSP request against a document synced
 * from the snapshot, with the answer mapped back to snapshot paths. The process, the
 * open documents and the path mapping are `LspProcess`, `Documents` and `Locator`;
 * this is where the requests and their result shapes live.
 */
export class LspBridge {
  private readonly process: LspProcess;
  private readonly documents: Documents;
  private readonly locator: Locator;

  constructor(private readonly opts: LspBridgeOptions) {
    this.process = new LspProcess(opts);
    this.documents = new Documents({
      connection: () => this.process.connection(),
      read: opts.read,
      uri: (path) => this.uri(path),
      maxOpen: opts.maxOpen,
    });
    this.locator = new Locator({
      root: opts.root,
      read: opts.read,
      has: opts.has,
      textOf: (path) => this.documents.textOf(path),
    });
  }

  status(): LspProcessStatus {
    return this.process.status();
  }

  /** The retained log lines, oldest first. */
  entries(): LspLogEntry[] {
    return this.process.entries();
  }

  /** What the server's `initialize` result advertised; empty while starting. */
  features(): LspFeature[] {
    return this.process.features();
  }

  async definition(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.locations('definition', 'textDocument/definition', pos);
  }

  async typeDefinition(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.locations('typeDefinition', 'textDocument/typeDefinition', pos);
  }

  async references(pos: LspPosition): Promise<LspLocationsResponse> {
    return this.locations('references', 'textDocument/references', pos, { context: { includeDeclaration: true } });
  }

  async hover(pos: LspPosition): Promise<LspHoverResponse> {
    const { result, busy } = await this.query<null | { contents: HoverContents; range?: Range }>(
      'textDocument/hover',
      { textDocument: { uri: this.uri(pos.path) }, position: toLsp(pos) },
      pos.path,
      'hover',
    );
    const md = result ? hoverMarkdown(result.contents) : null;
    if (md == null) return inconclusive({ contents: null }, true, busy);
    const res: LspHoverResponse = { contents: localizeFileLinks(md, await this.locator.links(md)) };
    if (result?.range) res.range = fromLsp(result.range);
    return res;
  }

  /**
   * Where else the symbol at `pos` occurs in its file, via `textDocument/documentHighlight`,
   * so scope and shadowing are the server's call. A server not offering the request, or a
   * position holding no symbol, yields no occurrences: the answer is advisory.
   */
  async occurrences(pos: LspPosition): Promise<LspOccurrencesResponse> {
    const { result } = await this.query<DocumentHighlight[] | null>(
      'textDocument/documentHighlight',
      { textDocument: { uri: this.uri(pos.path) }, position: toLsp(pos) },
      pos.path,
      'documentHighlight',
    ).catch(unsupported(null));
    return {
      occurrences: (result ?? []).map(({ range, kind }) => ({
        ...fromLsp(range),
        kind: kind === 3 ? 'write' : kind === 2 ? 'read' : 'text',
      })),
    };
  }

  /** Keeps the diff's own files open in the server (see `Documents.track`). Never throws. */
  track(paths: string[]): Promise<void> {
    return this.documents.track(paths);
  }

  async documentSymbols(path: string): Promise<LspSymbolsResponse> {
    const { result, busy } = await this.query<DocumentSymbol[] | SymbolInformation[] | null>(
      'textDocument/documentSymbol',
      { textDocument: { uri: this.uri(path) } },
      path,
      'documentSymbol',
    );
    const symbols = result ? flattenSymbols(result, path) : [];
    return inconclusive({ symbols }, !symbols.length, busy);
  }

  /**
   * Symbols the server knows for `query`, limited to paths the snapshot exposes, in the
   * server's order: the pool ranks the union. Membership comes from `has`, never from
   * reading the file: a per-keystroke search must not read every hit's text.
   */
  async workspaceSymbols(query: string): Promise<LspSymbolsResponse> {
    const { result, busy } = await this.query<SymbolInformation[] | null>(
      'workspace/symbol',
      { query },
      undefined,
      'workspaceSymbol',
    );
    if (!result) return inconclusive({ symbols: [] }, true, busy);
    const paths = await Promise.all(result.map((s) => this.locator.pathOf(s.location.uri)));
    const inside = await this.locator.membership(paths);
    const out: LspSymbol[] = [];
    const seen = new Set<string>();
    result.forEach((s, i) => {
      const path = paths[i];
      if (path == null || !inside.get(path)) return;
      const symbol = symbolInformation(s, path);
      // pyrefly reports one entry per import site; one per definition is enough here.
      const key = `${path}:${symbol.line}:${symbol.col}:${symbol.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(symbol);
    });
    return inconclusive({ symbols: out }, !out.length, busy);
  }

  /** Reads a file outside the snapshot only if a result named it (see `Locator.readExternal`). */
  readExternal(path: string): Promise<Buffer | null> {
    return this.locator.readExternal(path);
  }

  /** Replaces the server's settings (see `LspProcess.reconfigure`). */
  reconfigure(settings: Promise<LspSettings>): void {
    this.process.reconfigure(settings);
  }

  close(): Promise<void> {
    return this.process.close();
  }

  private async locations(
    feature: LspFeature,
    method: string,
    pos: LspPosition,
    extra: object = {},
  ): Promise<LspLocationsResponse> {
    const { result, busy } = await this.query<null | Location | Location[] | LocationLink[]>(
      method,
      { textDocument: { uri: this.uri(pos.path) }, position: toLsp(pos), ...extra },
      pos.path,
      feature,
    );
    const locations = await this.locator.locations(normalizeLocations(result));
    return inconclusive({ locations }, !locations.length, busy);
  }

  /**
   * One request against a synced document, re-asked while the server answers
   * `ContentModified`: something moved the document under it — a watcher refresh, or a
   * `track` pass opening the diff — so it refuses to answer from text it no longer holds.
   * Re-syncing and asking again is what an editor does. Giving up reads as an outage, the
   * one thing the reader can act on, rather than as a failed route. A `feature` the
   * server never advertised is not asked for. `busy` is why an empty `result` may be
   * incomplete: background work the server reported before or during the request.
   */
  private async query<T>(
    method: string,
    params: object,
    path?: string,
    feature?: LspFeature,
  ): Promise<{ result: T; busy: string | null }> {
    for (let attempt = 0; ; attempt++) {
      if (path != null) await this.documents.sync(path);
      const rpc = await this.process.connection();
      if (feature && !this.process.supports(feature))
        throw new LspUnsupportedError(`${this.process.name} offers no ${LSP_FEATURE_LABELS[feature]}`);
      try {
        const pending = this.process.busy();
        const result = await rpc.request<T>(method, params);
        return { result, busy: this.process.busy() ?? pending };
      } catch (e) {
        if (!(e instanceof JsonRpcError) || e.code !== CONTENT_MODIFIED) throw e;
        const backoff = CONTENT_MODIFIED_BACKOFF_MS[attempt];
        if (backoff == null)
          throw new LspUnavailableError(
            `${this.process.name} could not answer while ${path ?? 'the repository'} kept changing; try again`,
          );
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private uri(path: string): string {
    return pathToFileURL(join(this.opts.root, path)).href;
  }
}

/** A catch handler answering `result` for a request the server does not offer; anything else propagates. */
function unsupported<T>(result: T): (e: unknown) => { result: T; busy: null } {
  return (e) => {
    if (e instanceof LspUnsupportedError) return { result, busy: null };
    throw e;
  };
}
