import type { Hono } from 'hono';
import {
  ClearThreadsQuerySchema,
  GithubExportRequestSchema,
  MessagePatchSchema,
  ReplyCreateSchema,
  ResolvedRequestSchema,
  ThreadQuerySchema,
  ViewedBulkRequestSchema,
  ViewedEntrySchema,
} from '@/shared/protocol.js';
import { NotFoundError } from '@/server/comments/CommentStore.js';
import { formatPrompt } from '@/server/comments/format.js';
import { parseImports } from '@/server/comments/import.js';
import type { ApiDeps } from './api.js';
import { readJson } from './body.js';

/** Comment threads, their export to a pending GitHub review, and viewed marks. Each write broadcasts its invalidation. */
export function commentRoutes(app: Hono, { session, hub }: ApiDeps): void {
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
    const { added } = await session.comments.importThreads(imports, session.anchorSource());
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

  // Adds threads to a pending review on the matching pull request; the human submits it on GitHub.
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
}
