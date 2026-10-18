import type { Hono } from 'hono';
import {
  followsCheckout,
  LspPositionSchema,
  type LspStatus,
  lspBlocker,
  SymbolsQuerySchema,
} from '../../shared/protocol.js';
import type { LspPool } from '../lsp/LspPool.js';
import type { ApiDeps } from './api.js';
import { readJson } from './body.js';

/** Symbol navigation, answered only while the new side is the checkout the language servers read. */
export function lspRoutes(app: Hono, deps: ApiDeps): void {
  const { session } = deps;
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

  app.post('/api/lsp/occurrences', async (c) => {
    const pos = LspPositionSchema.parse(await readJson(c));
    const r = await lspFor(pos.path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(await r.lsp.occurrences(pos));
  });

  app.get('/api/lsp/symbols', async (c) => {
    const { path, q: query } = SymbolsQuerySchema.parse(c.req.query());
    const r = await lspFor(path);
    if ('error' in r) return c.json({ error: r.error }, 409);
    return c.json(path != null ? await r.lsp.documentSymbols(path) : await r.lsp.workspaceSymbols(query ?? ''));
  });
}

function lspStatus(deps: ApiDeps): LspStatus {
  return deps.lsp?.status() ?? { enabled: false, servers: [], missing: [] };
}
