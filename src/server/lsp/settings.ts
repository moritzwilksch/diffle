import type { LanguageId } from '../../shared/protocol.js';

const CATALOG_URL = 'https://www.schemastore.org/api/json/catalog.json';
type Settings = Record<string, unknown>;
interface SchemaAssociation {
  url: string;
  fileMatch: string[];
}

/** Settings supplied to schema-aware servers; TOML servers retain their project configuration. */
export function defaultSettings(languages: readonly LanguageId[]): Settings {
  return {
    ...(languages.includes('yaml') ? { yaml: { schemaStore: { enable: true, url: CATALOG_URL } } } : {}),
    ...(languages.includes('toml') ? { evenBetterToml: { schema: { enabled: true, catalogs: [CATALOG_URL] } } } : {}),
  };
}

/** Resolves each requested configuration section in order, including unconfigured sections. */
export function configuration(settings: Settings, params: unknown): unknown[] {
  const items = (params as { items?: { section?: string }[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    let value: unknown = settings;
    for (const part of item.section?.split('.') ?? []) {
      value = value && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Settings)[part] : undefined;
    }
    return value ?? {};
  });
}

/** Downloads filename associations for JSON servers. Offline or invalid catalogs yield none. */
export async function jsonSchemas(fetchCatalog: typeof fetch = fetch): Promise<SchemaAssociation[]> {
  try {
    const response = await fetchCatalog(CATALOG_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const catalog = (await response.json()) as { schemas?: unknown[] };
    if (!Array.isArray(catalog.schemas)) return [];
    return catalog.schemas.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { url, fileMatch } = entry as Partial<SchemaAssociation>;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !Array.isArray(fileMatch)) return [];
      const patterns = fileMatch.filter((p): p is string => typeof p === 'string');
      return patterns.length ? [{ url, fileMatch: patterns }] : [];
    });
  } catch {
    // Catalog availability must not prevent local symbols or explicit $schema use.
    return [];
  }
}
