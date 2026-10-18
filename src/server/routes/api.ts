import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  type FileResponse,
  type SearchResponse,
  type UserConfig,
  ModeRequestSchema,
  PatchRequestSchema,
  FileQuerySchema,
  ImageQuerySchema,
  LastCommitsQuerySchema,
  SearchQuerySchema,
  ConfigUpdateSchema,
  PatchQuerySchema,
} from '../../shared/protocol.js';
import { NotFoundError, UnquotableError } from '../comments/CommentStore.js';
import { shownRanges } from '../comments/hunks.js';
import { mapLimit } from '../concurrency.js';
import { ImportError } from '../comments/import.js';
import { GitError, isBinary } from '../git/GitRepo.js';
import { GithubError } from '../github/client.js';
import { imageType } from '../image.js';
import { LspUnavailableError } from '../lsp/LspProcess.js';
import type { LspPool } from '../lsp/LspPool.js';
import { RevspecError } from '../mode/revspec.js';
import type { Session } from '../Session.js';
import type { UserConfigStore } from '../UserConfig.js';
import type { WsHub } from '../ws.js';
import { readJson } from './body.js';
import { commentRoutes } from './comments.js';
import { lspRoutes } from './lsp.js';

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

  app.get('/api/moved', (c) => c.json(session.moved));

  app.post('/api/reload', async (c) => c.json(await session.reload()));

  app.delete('/api/iterations', async (c) => c.json(await session.clearIterations()));

  app.delete('/api/iterations/:n', async (c) => {
    const n = Number(c.req.param('n'));
    if (!Number.isInteger(n) || n < 1) throw new RevspecError(`not an iteration number: ${c.req.param('n')}`);
    return c.json(await session.deleteIteration(n));
  });

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

  // Snapshot files only: `readExternal` stays the one read outside the allowlist.
  app.get('/api/image', async (c) => {
    const { path, rev, key } = ImageQuerySchema.parse(c.req.query());
    const buf = await session.readImage(await session.snapshotter.current(), path, rev, key);
    const type = buf && imageType(buf);
    if (!type) return c.json({ error: 'no image under that key' }, 404);
    return c.body(new Uint8Array(buf), 200, {
      'content-type': type,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      // An <img> from another site sends no Origin, so the origin guard passes it; this blocks the embed.
      'cross-origin-resource-policy': 'same-origin',
    });
  });

  app.get('/api/search', async (c) => {
    const query = SearchQuerySchema.parse(c.req.query());
    const { q, scope } = query;
    const snap = await session.snapshotter.current();
    // File scope is pinned to the new-side allowlist; global text search covers changed files.
    let paths =
      scope === 'repo'
        ? undefined
        : scope === 'file'
          ? snap.tree.filter((p) => p === query.path)
          : snap.changed.filter((f) => f.status !== 'D').map((f) => f.path);
    let ranges: Map<string, [number, number][]> | undefined;
    if (query.content === 'diff') {
      const candidates = snap.changed.filter(
        (f) => f.status !== 'D' && !f.binary && (!paths || paths.includes(f.path)),
      );
      const entries = await mapLimit(candidates, 8, async (file) => {
        const patch = await session.repo.patch(snap.oldSha, snap.newSha, file, snap.context);
        return [file.path, shownRanges(patch, 'new')] as const;
      });
      ranges = new Map(entries);
      paths = entries.filter(([, spans]) => spans.length > 0).map(([path]) => path);
    }
    const { matches, truncated } = await session.repo.grep(q, snap.newSha, 500, {
      word: query.word,
      ignoreCase: query.i,
      regex: query.re,
      paths,
      ranges,
    });
    const body: SearchResponse = { query: q, matches, truncated };
    return c.json(body);
  });

  commentRoutes(app, deps);
  lspRoutes(app, deps);

  app.get('/api/config', (c) => c.json(effectiveConfig(deps)));

  app.put('/api/config', async (c) => {
    const body = ConfigUpdateSchema.parse(await readJson(c));
    await deps.config.set(body);
    hub.broadcast({ type: 'config' });
    // The session keeps its own context (`--context` or the config at startup); only an explicit change moves it.
    if (body.contextLines != null) await session.setContext(deps.config.get().contextLines);
    if (body.followRefs != null) session.setFollowRefs(deps.config.get().followRefs);
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
