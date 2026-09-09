import type {
  CommentThread,
  FileResponse,
  GithubExportRequest,
  GithubExportResponse,
  LspHoverResponse,
  LspLocationsResponse,
  LspPosition,
  LspStatus,
  LspTokenKindResponse,
  LspSymbol,
  ModeRequest,
  PatchRequest,
  RefsResponse,
  ReplyCreate,
  SearchResponse,
  SearchScope,
  ServerMessage,
  Side,
  Snapshot,
  ThreadCreate,
  ThreadQuery,
  UserConfig,
  ViewedEntry,
} from '../shared/protocol.js';

// The only module that knows URLs.

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await safeMessage(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function text(input: string, init?: RequestInit): Promise<string> {
  const res = await fetch(input, init);
  if (!res.ok) throw new ApiError(res.status, await safeMessage(res));
  return res.text();
}

async function safeMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
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
  snapshot: () => json<Snapshot>('/api/snapshot'),
  switchMode: (req: ModeRequest) => json<Snapshot>('/api/mode', { method: 'POST', body: JSON.stringify(req) }),
  refs: () => json<RefsResponse>('/api/refs'),
  patch: (path: string) => text(`/api/patch?${q({ path })}`),
  /** Patches of several changed files in one response. */
  patches: (paths: string[]) => text('/api/patch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths } satisfies PatchRequest) }),
  /** One side's full contents; `signal` aborts the request when its consumer no longer wants it. */
  file: (path: string, rev: Side, signal?: AbortSignal) => json<FileResponse>(`/api/file?${q({ path, rev })}`, { signal }),
  /** `path` names the file a `scope: 'file'` search is confined to. */
  search: (query: string, opts: { word?: boolean; ignoreCase?: boolean; regex?: boolean; scope?: SearchScope; path?: string } = {}) =>
    json<SearchResponse>(
      `/api/search?${q({ q: query, word: opts.word ? '1' : undefined, i: opts.ignoreCase ? '1' : undefined, re: opts.regex ? '1' : undefined, scope: opts.scope, path: opts.path })}`,
    ),
  threads: (query: ThreadQuery = {}) => json<CommentThread[]>(`/api/threads?${q({ state: query.state, path: query.path })}`),
  /** Open threads as the agent prompt. */
  exportComments: () => text(`/api/threads/export?${q({ state: 'open' })}`),
  /** Posts threads as a review on the current branch's pull request; all unresolved ones without `threadIds`. */
  exportToGithub: (req: GithubExportRequest = {}) => json<GithubExportResponse>('/api/github/export', { method: 'POST', body: JSON.stringify(req) }),
  addThread: (t: ThreadCreate) => json<CommentThread[]>('/api/threads', { method: 'POST', body: JSON.stringify(t) }),
  reply: (id: string, r: ReplyCreate) => json<CommentThread>(`/api/threads/${encodeURIComponent(id)}/replies`, { method: 'POST', body: JSON.stringify(r) }),
  editMessage: (id: string, mid: string, body: string) =>
    json<CommentThread>(`/api/threads/${encodeURIComponent(id)}/messages/${encodeURIComponent(mid)}`, { method: 'PATCH', body: JSON.stringify({ body }) }),
  deleteMessage: (id: string, mid: string) =>
    json<CommentThread | void>(`/api/threads/${encodeURIComponent(id)}/messages/${encodeURIComponent(mid)}`, { method: 'DELETE' }),
  setResolved: (id: string, resolved: boolean) =>
    json<CommentThread>(`/api/threads/${encodeURIComponent(id)}/resolved`, { method: 'PUT', body: JSON.stringify({ resolved }) }),
  deleteThread: (id: string) => json<void>(`/api/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearThreads: () => json<void>('/api/threads', { method: 'DELETE' }),
  deleteStaleThreads: () => json<void>('/api/threads?stale=1', { method: 'DELETE' }),
  viewed: () => json<ViewedEntry[]>('/api/viewed'),
  setViewedBulk: (entries: ViewedEntry[]) => json<ViewedEntry[]>('/api/viewed/bulk', { method: 'PUT', body: JSON.stringify({ entries }) }),
  setViewed: (path: string, blob: string, viewed: boolean) =>
    json<ViewedEntry[]>('/api/viewed', { method: 'PUT', body: JSON.stringify({ path, blob, viewed }) }),
  lspStatus: () => json<LspStatus>('/api/lsp/status'),
  lspDefinition: (pos: LspPosition) => json<LspLocationsResponse>('/api/lsp/definition', { method: 'POST', body: JSON.stringify(pos) }),
  lspTypeDefinition: (pos: LspPosition) => json<LspLocationsResponse>('/api/lsp/type-definition', { method: 'POST', body: JSON.stringify(pos) }),
  /** What the server knows about the symbol at `pos`, as markdown. */
  lspHover: (pos: LspPosition) => json<LspHoverResponse>('/api/lsp/hover', { method: 'POST', body: JSON.stringify(pos) }),
  /** What class of token sits at `pos`; `keyword` means symbol navigation has nothing to offer. */
  lspTokenKind: (pos: LspPosition) => json<LspTokenKindResponse>('/api/lsp/token-kind', { method: 'POST', body: JSON.stringify(pos) }),
  lspReferences: (pos: LspPosition) => json<LspLocationsResponse>('/api/lsp/references', { method: 'POST', body: JSON.stringify(pos) }),
  /** Document symbols for a path, or workspace symbols matching a query. */
  lspSymbols: (query: { path: string } | { q: string }) => json<LspSymbol[]>(`/api/lsp/symbols?${q(query)}`),
  /** Changed declarations in a file with their call sites outside the diff. */
  config: () => json<UserConfig>('/api/config'),
  /** lspCommand is CLI-only; the server ignores it. */
  saveConfig: (config: Partial<Pick<UserConfig, 'autoViewed' | 'contextLines'>>) => json<UserConfig>('/api/config', { method: 'PUT', body: JSON.stringify(config) }),
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
        onMessage(JSON.parse(String(e.data)) as ServerMessage);
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
