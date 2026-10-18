import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../persist.js';
import { JsonRpcError } from './JsonRpc.js';

export const SCHEMA_CATALOG = 'https://www.schemastore.org/api/json/catalog.json';
const MAX_AGE = 24 * 60 * 60 * 1000;
const AssociationSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  fileMatch: z.array(z.string()).nonempty(),
});
type Association = z.infer<typeof AssociationSchema>;
const SchemaCatalogSchema = z.object({ schemas: z.array(z.unknown()) });
const ConfigurationParamsSchema = z.object({
  items: z.array(z.object({ section: z.string().optional() })),
});
/** A server's settings tree, as `workspace/didChangeConfiguration` carries it. */
export type LspSettings = Record<string, unknown>;

/** Valid catalog entries, in the association format understood by the JSON server. */
export function schemaAssociations(value: unknown): Association[] {
  const catalog = SchemaCatalogSchema.safeParse(value);
  if (!catalog.success) return [];
  return catalog.data.schemas.flatMap((entry) => {
    const association = AssociationSchema.safeParse(entry);
    return association.success ? [association.data] : [];
  });
}

/** Caches catalog discovery for a day and uses the last good copy when offline. */
export async function loadSchemaCatalog(
  cacheFile = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'diffle', 'schemastore.json'),
  request: typeof fetch = fetch,
): Promise<Association[]> {
  let cached: Association[] = [];
  try {
    cached = schemaAssociations(JSON.parse(await readFile(cacheFile, 'utf8')));
    if (cached.length && Date.now() - (await stat(cacheFile)).mtimeMs < MAX_AGE) return cached;
  } catch {
    /* No usable cache yet. */
  }
  try {
    const response = await request(SCHEMA_CATALOG, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return cached;
    const schemas = schemaAssociations(await response.json());
    if (!schemas.length) return cached;
    // Cache failure must not prevent hover in read-only environments.
    await writeFileAtomic(cacheFile, JSON.stringify({ schemas }) + '\n').catch(() => {});
    return schemas;
  } catch {
    return cached;
  }
}

/**
 * Answers a language server's `workspace/configuration` request from `settings`:
 * each requested section in order, null for unknown sections, and the whole tree
 * for an omitted section. Params are untrusted JSON from the server; malformed
 * requests throw JSON-RPC Invalid Params before any settings are returned.
 */
export function configurationItems(settings: LspSettings, params: unknown): unknown[] {
  const request = ConfigurationParamsSchema.safeParse(params);
  if (!request.success) throw new JsonRpcError(-32602, 'Invalid workspace/configuration parameters');
  return request.data.items.map((item) => {
    if (!item.section) return settings;
    let value: unknown = settings;
    for (const part of item.section.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return null;
      value = (value as LspSettings)[part];
    }
    return value ?? null;
  });
}
