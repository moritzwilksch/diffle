import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  type FileResponse,
  type SearchResponse,
  type LspStatus,
  type UserConfig,
  ModeRequestSchema,
  PatchRequestSchema,
  FileQuerySchema,
  LastCommitsQuerySchema,
  SearchQuerySchema,
  ThreadQuerySchema,
  ReplyCreateSchema,
  MessagePatchSchema,
  ResolvedRequestSchema,
  GithubExportRequestSchema,
  ViewedBulkRequestSchema,
  ViewedEntrySchema,
  LspPositionSchema,
  SymbolsQuerySchema,
  ConfigUpdateSchema,
  ClearThreadsQuerySchema,
  PatchQuerySchema,
  followsCheckout,
  lspBlocker,
} from '../shared/protocol.js';
import { NotFoundError, UnquotableError } from './comments/CommentStore.js';
import { formatPrompt } from './comments/format.js';
import { ImportError, parseImports } from './comments/import.js';
import { GitError, isBinary } from './git/GitRepo.js';
import { GithubError } from './github.js';
import { LspUnavailableError } from './lsp/LspBridge.js';
import type { LspPool } from './lsp/LspPool.js';
import { RevspecError } from './revspec.js';
import type { Session } from './Session.js';
import type { UserConfigStore } from './UserConfig.js';
import type { WsHub } from './ws.js';

/** Invalid JSON is a request error; failures after parsing still propagate. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' });
  }
}

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

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err) }, 400);
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
    const req = ModeRequestSchema.parse(await readJson(c));
    return c.json(await session.switchMode(req));
  });

  app.get('/api/github', async (c) => {
    const snap = await session.snapshotter.current();
    return c.json(await session.github(snap));
  });

  app.get('/api/refs', async (c) => c.json(await session.repo.refs()));

  app.get('/api/last-commits-preview', async (c) => {
    const { oldOffset, newOffset } = LastCommitsQuerySchema.parse(c.req.query());
    return c.json(await session.repo.lastCommitsPreview(oldOffset, newOffset));
  });

  app.get('/api/patch', async (c) => {
    const { path } = PatchQuerySchema.parse(c.req.query());
    if (!path) return c.text(await session.snapshotter.patchAll());
    const patch = await session.snapshotter.patch(path);
    if (patch == null) return c.json({ error: 'not a changed file' }, 404);
    return c.text(patch);
  });

  // A path list in the body: a client loads a review in bounded batches, and a refresh only its changed files.
  app.post('/api/patch', async (c) => {
    const { paths } = PatchRequestSchema.parse(await readJson(c));
    return c.text(await session.snapshotter.patchMany(paths));
  });

  app.get('/api/file', async (c) => {
    const { path, rev } = FileQuerySchema.parse(c.req.query());
    const snap = await session.snapshotter.current();
    // Outside the snapshot only a file the language server named is readable (see LspBridge.readExternal).
    const buf =
      (await session.readSide(snap, path, rev)) ?? (rev === 'new' ? await deps.lsp?.readExternal(path) : null);
    if (buf == null) return c.json({ error: 'absent on that side' }, 404);
    const binary = isBinary(buf);
    const body: FileResponse = { path, contents: binary ? '' : buf.toString('utf8'), binary };
    return c.json(body);
  });

  app.get('/api/search', async (c) => {
    const query = SearchQuerySchema.parse(c.req.query());
    const { q, scope } = query;
    const snap = await session.snapshotter.current();
    // Default scope is the diff's new side; `scope=repo` widens to the whole tree, `scope=file`
    // narrows to `path`, which must be on the new side (an unknown path matches nothing).
    const paths =
      scope === 'repo'
        ? undefined
        : scope === 'file'
          ? snap.tree.filter((p) => p === query.path)
          : snap.changed.filter((f) => f.status !== 'D').map((f) => f.path);
    const { matches, truncated } = await session.repo.grep(q, snap.newSha, 500, {
      word: query.word,
      ignoreCase: query.i,
      regex: query.re,
      paths,
    });
    const body: SearchResponse = { query: q, matches, truncated };
    return c.json(body);
  });

  app.get('/api/threads', (c) => {
    const q = ThreadQuerySchema.parse(c.req.query());
    q.state ??= 'all';
    return c.json(session.comments.threads(q));
  });

  app.get('/api/threads/export', (c) => {
    const q = ThreadQuerySchema.parse(c.req.query());
    q.state ??= 'open';
    return c.text(formatPrompt(session.comments.threads(q)));
  });

  app.get('/api/threads/:id/messages/:mid/export', (c) => {
    const thread = session.comments.get(c.req.param('id'));
    if (!thread) throw new NotFoundError(c.req.param('id'));
    const message = thread.messages.find((m) => m.id === c.req.param('mid'));
    if (!message) throw new NotFoundError(c.req.param('mid'));
    return c.text(formatPrompt([{ ...thread, messages: [message] }]));
  });

  // One object or an array. Returns what was created; open duplicates are skipped.
  app.post('/api/threads', async (c) => {
    const imports = parseImports(await readJson(c));
    const { added } = await session.comments.importThreads(imports, session.quoter());
    if (added.length) hub.broadcast({ type: 'threads' });
    return c.json(added, 201);
  });

  app.post('/api/threads/:id/replies', async (c) => {
    const body = ReplyCreateSchema.parse(await readJson(c));
    const t = await session.comments.reply(c.req.param('id'), { body: body.body });
    hub.broadcast({ type: 'threads' });
    return c.json(t, 201);
  });

  app.patch('/api/threads/:id/messages/:mid', async (c) => {
    const body = MessagePatchSchema.parse(await readJson(c));
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
    const body = ResolvedRequestSchema.parse(await readJson(c));
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
    const { stale } = ClearThreadsQuerySchema.parse(c.req.query());
    if (stale === '1') await session.comments.removeStale();
    else await session.comments.clear();
    hub.broadcast({ type: 'threads' });
    return c.body(null, 204);
  });

  // Adds threads to a pending review on the matching pull request through the local `gh`; the human submits it on GitHub.
  app.post('/api/github/export', async (c) => {
    const body = GithubExportRequestSchema.parse(await readJson(c));
    return c.json(await session.exportGithub(body));
  });

  app.get('/api/viewed', (c) => c.json(session.comments.viewed()));

  app.put('/api/viewed/bulk', async (c) => {
    const { entries } = ViewedBulkRequestSchema.parse(await readJson(c));
    const list = await session.comments.setViewedMany(entries);
    hub.broadcast({ type: 'viewed' });
    return c.json(list);
  });

  app.put('/api/viewed', async (c) => {
    const body = ViewedEntrySchema.parse(await readJson(c));
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
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.definition(pos));
  });

  app.post('/api/lsp/type-definition', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.typeDefinition(pos));
  });

  app.post('/api/lsp/hover', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.hover(pos));
  });

  app.post('/api/lsp/token-kind', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.tokenKind(pos));
  });

  app.post('/api/lsp/references', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.references(pos));
  });

  app.get('/api/lsp/symbols', async (c) => {
    const { path, q: query } = SymbolsQuerySchema.parse(c.req.query());
    const r = await lspFor(path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(path != null ? await r.lsp.documentSymbols(path) : await r.lsp.workspaceSymbols(query ?? ''));
  });

  app.get('/api/config', (c) => c.json(effectiveConfig(deps)));

  app.put('/api/config', async (c) => {
    const body = ConfigUpdateSchema.parse(await readJson(c));
    await deps.config.set(body);
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
