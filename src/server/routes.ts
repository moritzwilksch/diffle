import { Hono } from 'hono';
import type {
  FileResponse,
  GithubExportRequest,
  LspPosition,
  LspStatus,
  MessagePatch,
  ModeRequest,
  PatchRequest,
  ReplyCreate,
  SearchResponse,
  Side,
  ThreadQuery,
  ThreadState,
  UserConfig,
  ViewedEntry,
} from '../shared/protocol.js';
import { followsCheckout, lspBlocker } from '../shared/protocol.js';
import { NotFoundError, UnquotableError } from './comments/CommentStore.js';
import { formatPrompt } from './comments/format.js';
import { ImportError, parseImports } from './comments/import.js';
import { GitError, isBinary } from './git/GitRepo.js';
import { GithubExporter, GithubError } from './github.js';
import { LspUnavailableError } from './lsp/LspBridge.js';
import type { LspPool } from './lsp/LspPool.js';
import { RevspecError } from './revspec.js';
import type { Session } from './Session.js';
import type { UserConfigStore } from './UserConfig.js';
import type { WsHub } from './ws.js';

/** Paths ride git's argv; a client batch is far smaller than this. */
const MAX_PATCH_PATHS = 200;

export interface ApiDeps {
  session: Session;
  config: UserConfigStore;
  /** Session-only additions from `--auto-viewed`. */
  extraAutoViewed: string[];
  hub: WsHub;
  /** The language servers, unless the run disabled them with `--no-lsp`. */
  lsp: LspPool | null;
}

export function createApi(deps: ApiDeps): Hono {
  const { session, hub } = deps;
  const app = new Hono();
  const github = new GithubExporter();

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: 'not found' }, 404);
    if (err instanceof RevspecError || err instanceof GitError) return c.json({ error: err.message }, 400);
    if (err instanceof ImportError || err instanceof UnquotableError) return c.json({ error: err.message }, 400);
    if (err instanceof LspUnavailableError) return c.json({ error: err.message }, 409);
    if (err instanceof GithubError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // Every request waits for the first mode to resolve.
  app.use('/api/*', async (c, next) => {
    if (c.req.path !== '/api/config') await session.ready();
    await next();
  });

  app.get('/api/snapshot', async (c) => c.json(await session.snapshotter.current()));

  app.post('/api/mode', async (c) => {
    const req = (await c.req.json()) as ModeRequest;
    if (!isModeRequest(req)) return c.json({ error: 'invalid mode request' }, 400);
    return c.json(await session.switchMode(req));
  });

  app.get('/api/refs', async (c) => c.json(await session.repo.refs()));

  app.get('/api/patch', async (c) => {
    const path = c.req.query('path');
    if (!path) return c.text(await session.snapshotter.patchAll());
    const patch = await session.snapshotter.patch(path);
    if (patch == null) return c.json({ error: 'not a changed file' }, 404);
    return c.text(patch);
  });

  // A path list in the body: a client loads a review in bounded batches, and a refresh only its changed files.
  app.post('/api/patch', async (c) => {
    const body = (await c.req.json()) as Partial<PatchRequest>;
    const paths = Array.isArray(body?.paths) && body.paths.every((p) => typeof p === 'string') ? body.paths : null;
    if (!paths) return c.json({ error: 'paths (string list) required' }, 400);
    if (paths.length > MAX_PATCH_PATHS) return c.json({ error: `at most ${MAX_PATCH_PATHS} paths per request` }, 400);
    return c.text(await session.snapshotter.patchMany(paths));
  });

  app.get('/api/file', async (c) => {
    const path = c.req.query('path');
    const rev = c.req.query('rev') as Side | undefined;
    if (!path || (rev !== 'old' && rev !== 'new')) return c.json({ error: 'path and rev=old|new required' }, 400);
    const snap = await session.snapshotter.current();
    const buf = await session.readSide(snap, path, rev);
    if (buf == null) return c.json({ error: 'absent on that side' }, 404);
    const binary = isBinary(buf);
    const body: FileResponse = { path, contents: binary ? '' : buf.toString('utf8'), binary };
    return c.json(body);
  });

  app.get('/api/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const snap = await session.snapshotter.current();
    const flag = (k: string) => c.req.query(k) === '1';
    // Default scope is the diff's new side; `scope=repo` widens to the whole tree, `scope=file`
    // narrows to `path`, which must be on the new side (an unknown path matches nothing).
    const scope = c.req.query('scope');
    const paths =
      scope === 'repo'
        ? undefined
        : scope === 'file'
          ? snap.tree.filter((p) => p === c.req.query('path'))
          : snap.changed.filter((f) => f.status !== 'D').map((f) => f.path);
    const { matches, truncated } = await session.repo.grep(q, snap.newSha, 500, {
      word: flag('word'),
      ignoreCase: flag('i'),
      regex: flag('re'),
      paths,
    });
    const body: SearchResponse = { query: q, matches, truncated };
    return c.json(body);
  });

  const threadQuery = (
    c: { req: { query(k: string): string | undefined } },
    defaultState: ThreadState,
  ): ThreadQuery | { error: string } => {
    const state = c.req.query('state') ?? defaultState;
    if (state !== 'open' && state !== 'resolved' && state !== 'all')
      return { error: 'state must be open, resolved or all' };
    const q: ThreadQuery = { state };
    const path = c.req.query('path');
    if (path) q.path = path;
    return q;
  };

  app.get('/api/threads', (c) => {
    const q = threadQuery(c, 'all');
    if ('error' in q) return c.json(q, 400);
    return c.json(session.comments.threads(q));
  });

  app.get('/api/threads/export', (c) => {
    const q = threadQuery(c, 'open');
    if ('error' in q) return c.json(q, 400);
    return c.text(formatPrompt(session.comments.threads(q)));
  });

  // One object or an array. Returns what was created; open duplicates are skipped.
  app.post('/api/threads', async (c) => {
    const imports = parseImports(await c.req.json());
    const { added } = await session.comments.importThreads(imports, session.quoter());
    if (added.length) hub.broadcast({ type: 'threads' });
    return c.json(added, 201);
  });

  app.post('/api/threads/:id/replies', async (c) => {
    const body = (await c.req.json()) as ReplyCreate;
    if (typeof body?.body !== 'string' || !body.body.trim()) return c.json({ error: 'body required' }, 400);
    const t = await session.comments.reply(c.req.param('id'), { body: body.body });
    hub.broadcast({ type: 'threads' });
    return c.json(t, 201);
  });

  app.patch('/api/threads/:id/messages/:mid', async (c) => {
    const body = (await c.req.json()) as MessagePatch;
    if (typeof body?.body !== 'string') return c.json({ error: 'body required' }, 400);
    const t = await session.comments.editMessage(c.req.param('id'), c.req.param('mid'), body.body);
    hub.broadcast({ type: 'threads' });
    return c.json(t);
  });

  app.delete('/api/threads/:id/messages/:mid', async (c) => {
    const t = await session.comments.removeMessage(c.req.param('id'), c.req.param('mid'));
    hub.broadcast({ type: 'threads' });
    return t ? c.json(t) : c.body(null, 204);
  });

  app.put('/api/threads/:id/resolved', async (c) => {
    const body = (await c.req.json()) as { resolved?: unknown };
    if (typeof body?.resolved !== 'boolean') return c.json({ error: 'resolved (boolean) required' }, 400);
    const t = await session.comments.setResolved(c.req.param('id'), body.resolved);
    hub.broadcast({ type: 'threads' });
    return c.json(t);
  });

  app.delete('/api/threads/:id', async (c) => {
    await session.comments.removeThread(c.req.param('id'));
    hub.broadcast({ type: 'threads' });
    return c.body(null, 204);
  });

  /** `?stale=1` deletes only stale threads; without it, every thread of this mode. */
  app.delete('/api/threads', async (c) => {
    if (c.req.query('stale') != null) await session.comments.removeStale();
    else await session.comments.clear();
    hub.broadcast({ type: 'threads' });
    return c.body(null, 204);
  });

  // Adds threads to a pending review on the checked-out branch's pull request through the local `gh`; the human submits it on GitHub.
  app.post('/api/github/export', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<GithubExportRequest>;
    const ids = body.threadIds;
    if (ids != null && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string')))
      return c.json({ error: 'threadIds must be a string list' }, 400);
    const snap = await session.snapshotter.current();
    return c.json(await github.export({ snap, threads: session.comments.threads({ state: 'all' }), threadIds: ids }));
  });

  app.get('/api/viewed', (c) => c.json(session.comments.viewed()));

  app.put('/api/viewed/bulk', async (c) => {
    const body = (await c.req.json()) as { entries?: unknown };
    const entries = Array.isArray(body.entries) ? (body.entries as unknown[]) : null;
    if (!entries || !entries.every(isViewedEntry)) return c.json({ error: 'entries required' }, 400);
    const list = await session.comments.setViewedMany(entries);
    hub.broadcast({ type: 'viewed' });
    return c.json(list);
  });

  app.put('/api/viewed', async (c) => {
    const body = (await c.req.json()) as { path?: unknown; blob?: unknown; viewed?: unknown };
    if (typeof body.path !== 'string' || typeof body.blob !== 'string' || typeof body.viewed !== 'boolean') {
      return c.json({ error: 'path, blob, viewed required' }, 400);
    }
    const list = await session.comments.setViewed(body.path, body.blob, body.viewed);
    hub.broadcast({ type: 'viewed' });
    return c.json(list);
  });

  app.get('/api/lsp/status', (c) => c.json(lspStatus(deps)));

  /** The pool, or a 409 reason: the language server reads the checkout, so the new side must be it. */
  const lspFor = async (path?: string): Promise<{ lsp: LspPool } | { error: string }> => {
    // Servers off for the run; a language with no server of its own is the pool's own answer.
    if (!deps.lsp) return { error: lspBlocker(lspStatus(deps)) ?? 'language servers are off' };
    const snap = await session.snapshotter.current();
    if (!followsCheckout(snap))
      return { error: 'Symbol navigation needs the new side to be the worktree or the checked-out commit' };
    if (path != null && !snap.tree.includes(path)) return { error: `${path} is not in the snapshot` };
    return { lsp: deps.lsp };
  };

  app.post('/api/lsp/definition', async (c) => {
    const pos = (await c.req.json()) as LspPosition;
    if (!isLspPosition(pos)) return c.json({ error: 'path, line, col required' }, 400);
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.definition(pos));
  });

  app.post('/api/lsp/type-definition', async (c) => {
    const pos = (await c.req.json()) as LspPosition;
    if (!isLspPosition(pos)) return c.json({ error: 'path, line, col required' }, 400);
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.typeDefinition(pos));
  });

  app.post('/api/lsp/hover', async (c) => {
    const pos = (await c.req.json()) as LspPosition;
    if (!isLspPosition(pos)) return c.json({ error: 'path, line, col required' }, 400);
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.hover(pos));
  });

  app.post('/api/lsp/token-kind', async (c) => {
    const pos = (await c.req.json()) as LspPosition;
    if (!isLspPosition(pos)) return c.json({ error: 'path, line, col required' }, 400);
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.tokenKind(pos));
  });

  app.post('/api/lsp/references', async (c) => {
    const pos = (await c.req.json()) as LspPosition;
    if (!isLspPosition(pos)) return c.json({ error: 'path, line, col required' }, 400);
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.references(pos));
  });

  app.get('/api/lsp/symbols', async (c) => {
    const path = c.req.query('path');
    const query = c.req.query('q');
    if (path == null && query == null) return c.json({ error: 'path or q required' }, 400);
    const r = await lspFor(path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(path != null ? await r.lsp.documentSymbols(path) : await r.lsp.workspaceSymbols(query ?? ''));
  });

  app.get('/api/config', (c) => c.json(effectiveConfig(deps)));

  app.put('/api/config', async (c) => {
    const body = (await c.req.json()) as Partial<UserConfig>;
    if (body.autoViewed != null && !Array.isArray(body.autoViewed))
      return c.json({ error: 'autoViewed must be a list' }, 400);
    if (body.contextLines != null && typeof body.contextLines !== 'number')
      return c.json({ error: 'contextLines must be a number' }, 400);
    // lspCommands hold shell commands; only the CLI may write them (`diffle config set-lsp`).
    const { lspCommands: _ignored, ...writable } = body;
    await deps.config.set(writable);
    hub.broadcast({ type: 'config' });
    // The session keeps its own context (`--context` or the config at startup); only an explicit change moves it.
    if (body.contextLines != null) await session.setContext(deps.config.get().contextLines);
    return c.json(effectiveConfig(deps));
  });

  return app;
}

/** The stored config plus this session's additions: `--auto-viewed` globs and the live context. */
function effectiveConfig(deps: ApiDeps): UserConfig {
  const c = deps.config.get();
  return {
    ...c,
    autoViewed: [...new Set([...c.autoViewed, ...deps.extraAutoViewed])],
    contextLines: deps.session.context,
  };
}

function lspStatus(deps: ApiDeps): LspStatus {
  return deps.lsp?.status() ?? { enabled: false, servers: [], missing: [] };
}

function isLspPosition(p: unknown): p is LspPosition {
  if (typeof p !== 'object' || p == null) return false;
  const x = p as Record<string, unknown>;
  return (
    typeof x.path === 'string' && typeof x.line === 'number' && x.line >= 1 && typeof x.col === 'number' && x.col >= 0
  );
}

function isViewedEntry(e: unknown): e is ViewedEntry {
  if (typeof e !== 'object' || e == null) return false;
  const x = e as Record<string, unknown>;
  return typeof x.path === 'string' && typeof x.blob === 'string' && typeof x.viewed === 'boolean';
}

function isModeRequest(r: unknown): r is ModeRequest {
  if (typeof r !== 'object' || r == null) return false;
  const x = r as Record<string, unknown>;
  switch (x.kind) {
    case 'working':
      return true;
    case 'pr':
      return x.pr == null || typeof x.pr === 'string';
    case 'revspec':
      return Array.isArray(x.args) && x.args.every((a) => typeof a === 'string');
    default:
      return false;
  }
}
