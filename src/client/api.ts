import { z } from 'zod';
import {
  ConfigUpdateSchema,
  GithubExportRequestSchema,
  LspPositionSchema,
  MessagePatchSchema,
  ModeRequestSchema,
  PatchRequestSchema,
  ReplyCreateSchema,
  ResolvedRequestSchema,
  ThreadCreateSchema,
  ViewedBulkRequestSchema,
  ApiErrorSchema,
  CommentThreadSchema,
  FileResponseSchema,
  GithubExportResponseSchema,
  GithubMetadataSchema,
  LastCommitsPreviewSchema,
  LspHoverResponseSchema,
  LspLocationsResponseSchema,
  LspStatusSchema,
  LspSymbolSchema,
  LspTokenKindResponseSchema,
  RefsResponseSchema,
  SearchResponseSchema,
  ServerMessageSchema,
  SnapshotSchema,
  UserConfigSchema,
  ViewedEntrySchema,
} from '../shared/protocol.js';
import type {
  GithubExportRequest,
  LspPosition,
  ModeRequest,
  ReplyCreate,
  SearchScope,
  ServerMessage,
  Side,
  ThreadCreate,
  ThreadQuery,
  ViewedEntry,
  ConfigUpdate,
  SymbolsQuery,
} from '../shared/protocol.js';

// The only module that knows URLs.

function encode<S extends z.ZodType>(schema: S, value: z.input<S>): string {
  return JSON.stringify(schema.parse(value));
}

async function json<T>(schema: z.ZodType<T>, input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await safeMessage(res));
  return schema.parse(res.status === 204 ? undefined : await res.json());
}

async function text(input: string, init?: RequestInit): Promise<string> {
  const res = await fetch(input, init);
  if (!res.ok) throw new ApiError(res.status, await safeMessage(res));
  return res.text();
}

async function safeMessage(res: Response): Promise<string> {
  try {
    const result = ApiErrorSchema.safeParse(await res.json());
    return result.success ? result.data.error : res.statusText;
  } catch {
    return res.statusText;
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const q = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] != null)).toString();

export const api = {
  github: () => json(GithubMetadataSchema, '/api/github'),
  snapshot: () => json(SnapshotSchema, '/api/snapshot'),
  switchMode: (req: ModeRequest) =>
    json(SnapshotSchema, '/api/mode', { method: 'POST', body: encode(ModeRequestSchema, req) }),
  refs: () => json(RefsResponseSchema, '/api/refs'),
  lastCommitsPreview: (oldOffset: number, newOffset: number, signal?: AbortSignal) =>
    json(
      LastCommitsPreviewSchema,
      `/api/last-commits-preview?${q({ oldOffset: String(oldOffset), newOffset: String(newOffset) })}`,
      { signal },
    ),
  patch: (path: string) => text(`/api/patch?${q({ path })}`),
  /** Patches of several changed files in one response. */
  patches: (paths: string[]) =>
    text('/api/patch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encode(PatchRequestSchema, { paths }),
    }),
  /** One side's full contents; `signal` aborts the request when its consumer no longer wants it. */
  file: (path: string, rev: Side, signal?: AbortSignal) =>
    json(FileResponseSchema, `/api/file?${q({ path, rev })}`, { signal }),
  /** `path` names the file a `scope: 'file'` search is confined to. */
  search: (
    query: string,
    opts: { word?: boolean; ignoreCase?: boolean; regex?: boolean; scope?: SearchScope; path?: string } = {},
  ) =>
    json(
      SearchResponseSchema,
      `/api/search?${q({ q: query, word: opts.word ? '1' : undefined, i: opts.ignoreCase ? '1' : undefined, re: opts.regex ? '1' : undefined, scope: opts.scope, path: opts.path })}`,
    ),
  threads: (query: ThreadQuery = {}) =>
    json(CommentThreadSchema.array(), `/api/threads?${q({ state: query.state, path: query.path })}`),
  /** Open threads as the agent prompt. */
  exportComments: () => text(`/api/threads/export?${q({ state: 'open' })}`),
  /** One message, with its thread's location and quote, as an agent prompt. */
  exportComment: (threadId: string, messageId: string) =>
    text(`/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/export`),
  /** Posts threads to the matching PR's pending review; all unresolved ones without `threadIds`. */
  exportToGithub: (req: GithubExportRequest) =>
    json(GithubExportResponseSchema, '/api/github/export', {
      method: 'POST',
      body: encode(GithubExportRequestSchema, req),
    }),
  addThread: (t: ThreadCreate) =>
    json(CommentThreadSchema.array(), '/api/threads', { method: 'POST', body: encode(ThreadCreateSchema, t) }),
  reply: (id: string, r: ReplyCreate) =>
    json(CommentThreadSchema, `/api/threads/${encodeURIComponent(id)}/replies`, {
      method: 'POST',
      body: encode(ReplyCreateSchema, r),
    }),
  editMessage: (id: string, mid: string, body: string) =>
    json(CommentThreadSchema, `/api/threads/${encodeURIComponent(id)}/messages/${encodeURIComponent(mid)}`, {
      method: 'PATCH',
      body: encode(MessagePatchSchema, { body }),
    }),
  deleteMessage: (id: string, mid: string) =>
    json(
      CommentThreadSchema.or(z.undefined()),
      `/api/threads/${encodeURIComponent(id)}/messages/${encodeURIComponent(mid)}`,
      {
        method: 'DELETE',
      },
    ),
  setResolved: (id: string, resolved: boolean) =>
    json(CommentThreadSchema, `/api/threads/${encodeURIComponent(id)}/resolved`, {
      method: 'PUT',
      body: encode(ResolvedRequestSchema, { resolved }),
    }),
  deleteThread: (id: string) => json(z.undefined(), `/api/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearThreads: () => json(z.undefined(), '/api/threads', { method: 'DELETE' }),
  deleteStaleThreads: () => json(z.undefined(), '/api/threads?stale=1', { method: 'DELETE' }),
  viewed: () => json(ViewedEntrySchema.array(), '/api/viewed'),
  setViewedBulk: (entries: ViewedEntry[]) =>
    json(ViewedEntrySchema.array(), '/api/viewed/bulk', {
      method: 'PUT',
      body: encode(ViewedBulkRequestSchema, { entries }),
    }),
  setViewed: (path: string, blob: string, viewed: boolean) =>
    json(ViewedEntrySchema.array(), '/api/viewed', {
      method: 'PUT',
      body: encode(ViewedEntrySchema, { path, blob, viewed }),
    }),
  lspStatus: () => json(LspStatusSchema, '/api/lsp/status'),
  lspDefinition: (pos: LspPosition) =>
    json(LspLocationsResponseSchema, '/api/lsp/definition', { method: 'POST', body: encode(LspPositionSchema, pos) }),
  lspTypeDefinition: (pos: LspPosition) =>
    json(LspLocationsResponseSchema, '/api/lsp/type-definition', {
      method: 'POST',
      body: encode(LspPositionSchema, pos),
    }),
  /** What the server knows about the symbol at `pos`, as markdown. */
  lspHover: (pos: LspPosition) =>
    json(LspHoverResponseSchema, '/api/lsp/hover', { method: 'POST', body: encode(LspPositionSchema, pos) }),
  /** What class of token sits at `pos`; `keyword` means symbol navigation has nothing to offer. */
  lspTokenKind: (pos: LspPosition) =>
    json(LspTokenKindResponseSchema, '/api/lsp/token-kind', { method: 'POST', body: encode(LspPositionSchema, pos) }),
  lspReferences: (pos: LspPosition) =>
    json(LspLocationsResponseSchema, '/api/lsp/references', { method: 'POST', body: encode(LspPositionSchema, pos) }),
  /** Document symbols for a path, or workspace symbols matching a query. */
  lspSymbols: (query: SymbolsQuery) => json(LspSymbolSchema.array(), `/api/lsp/symbols?${q(query)}`),
  config: () => json(UserConfigSchema, '/api/config'),
  /** lspCommands is CLI-only; the server ignores it. */
  saveConfig: (config: ConfigUpdate) =>
    json(UserConfigSchema, '/api/config', { method: 'PUT', body: encode(ConfigUpdateSchema, config) }),
};

/**
 * Auto-reconnecting WebSocket for server pushes. `onOpen` fires on every connection, the first
 * included: pushes are not replayed, so the caller resyncs there, and fetching only once the
 * socket is subscribed is what makes the resync authoritative.
 */
export function connectWs(onMessage: (msg: ServerMessage) => void, onOpen: () => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 500;
  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      delay = 500;
      onOpen();
    };
    ws.onmessage = (e) => {
      try {
        onMessage(ServerMessageSchema.parse(JSON.parse(String(e.data))));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
