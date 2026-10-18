import type { Hono } from 'hono';
import { LspPositionSchema, type LspStatus, LspLogQuerySchema, SymbolsQuerySchema } from '../../shared/protocol.js';
import { lspBlocker, type LspQuery } from '../../shared/lsp.js';
import type { LspPool } from '../lsp/LspPool.js';
import type { ApiDeps } from './api.js';
import { readJson } from './body.js';

/** Symbol navigation, answered only while the new side is the checkout the language servers read. */
export function lspRoutes(app: Hono, deps: ApiDeps): void {
  const { session } = deps;
  app.get('/api/lsp/status', (c) => c.json(lspStatus(deps)));

  // Readable whatever the snapshot shows: a log explains a server that cannot answer right now.
  app.get('/api/lsp/log', (c) => {
    const { server } = LspLogQuerySchema.parse(c.req.query());
    const entries = deps.lsp?.log(server);
    if (entries == null) return c.json({ error: 'no such language server' }, 404);
    return c.json({ entries });
  });

  /**
   * The pool, or the 409 reason `lspBlocker` gives: off, the wrong side, no server, or
   * not that feature. An advisory query names no feature: a server not offering it
   * answers nothing, which is no reason to refuse.
   */
  const lspFor = async ({ path, feature }: LspQuery): Promise<{ lsp: LspPool } | { error: string }> => {
    const snap = await session.snapshotter.current();
    const error = lspBlocker(lspStatus(deps), snap, { path, feature, patient: true });
    if (error != null || !deps.lsp) return { error: error ?? 'language servers are off' };
    if (path != null && !snap.tree.includes(path)) return { error: `${path} is not in the snapshot` };
    return { lsp: deps.lsp };
  };

  app.post('/api/lsp/definition', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor({ path: pos.path, feature: 'definition' });
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.definition(pos));
  });

  app.post('/api/lsp/type-definition', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor({ path: pos.path, feature: 'typeDefinition' });
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.typeDefinition(pos));
  });

  app.post('/api/lsp/hover', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor({ path: pos.path, feature: 'hover' });
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.hover(pos));
  });

  app.post('/api/lsp/references', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor({ path: pos.path, feature: 'references' });
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.references(pos));
  });

  app.post('/api/lsp/occurrences', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor({ path: pos.path });
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.occurrences(pos));
  });

  app.get('/api/lsp/symbols', async (c) => {
    const { path, q: query } = SymbolsQuerySchema.parse(c.req.query());
    const r = await lspFor({ path, feature: path != null ? 'documentSymbol' : 'workspaceSymbol' });
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(path != null ? await r.lsp.documentSymbols(path) : await r.lsp.workspaceSymbols(query ?? ''));
  });
}

function lspStatus(deps: ApiDeps): LspStatus {
  return deps.lsp?.status() ?? { enabled: false, servers: [], missing: [] };
}
