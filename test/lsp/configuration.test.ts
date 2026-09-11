import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  configurationItems,
  loadSchemaCatalog,
  schemaAssociations,
  settingsFor,
} from '../../src/server/lsp/configuration.js';
import { rmTmp } from '../tmp.js';
import { JsonRpcError } from '../../src/server/lsp/JsonRpc.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(rmTmp));
});
const schemas = [{ url: 'https://example.com/schema.json', fileMatch: ['package.json', '*.config.json'] }];

it('filters malformed catalog entries and preserves filename patterns', () => {
  expect(
    schemaAssociations({
      schemas: [
        ...schemas,
        null,
        { url: 'file:///secret', fileMatch: ['*'] },
        { url: 'https://example.com' },
        { url: 'https://', fileMatch: ['*'] },
        { url: 'https://example.com', fileMatch: [] },
        { url: 'https://example.com', fileMatch: [null] },
      ],
    }),
  ).toEqual(schemas);
});

it.each([null, [], {}, { schemas: null }])('ignores malformed catalogs: %j', (catalog) => {
  expect(schemaAssociations(catalog)).toEqual([]);
});

it.each([null, {}, { items: null }, { items: [null] }, { items: [42] }, { items: [{ section: false }] }])(
  'rejects malformed configuration requests: %j',
  (params) => {
    expect(() => configurationItems({}, params)).toThrowError(
      new JsonRpcError(-32602, 'Invalid workspace/configuration parameters'),
    );
  },
);

it('caches discovery, avoids fresh downloads, and falls back to stale data offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diffle-schema-'));
  dirs.push(dir);
  const file = join(dir, 'catalog.json');
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ schemas }));
  expect(await loadSchemaCatalog(file, request)).toEqual(schemas);
  expect(await loadSchemaCatalog(file, request)).toEqual(schemas);
  expect(request).toHaveBeenCalledTimes(1);
  await utimes(file, new Date(0), new Date(0));
  request.mockRejectedValue(new Error('offline'));
  expect(await loadSchemaCatalog(file, request)).toEqual(schemas);
  await writeFile(file, 'invalid JSON');
  expect(await loadSchemaCatalog(file, request)).toEqual([]);
});

it('answers whole and dotted configuration sections in request order', async () => {
  const settings = await settingsFor(['yaml', 'toml'], 'taplo lsp stdio');
  expect(
    configurationItems(settings, {
      items: [
        { section: 'yaml.hover' },
        { section: 'evenBetterToml.schema.enabled' },
        { section: 'missing' },
        {},
        { section: '__proto__' },
      ],
    }),
  ).toEqual([true, true, null, settings, null]);
});

it('leaves Tombi defaults intact and sends Taplo settings only to Taplo', async () => {
  expect(await settingsFor(['toml'], 'tombi lsp')).toEqual({});
  expect(await settingsFor(['toml'], '"C:\\tools\\taplo.exe" lsp stdio')).toHaveProperty(
    'evenBetterToml.schema.enabled',
    true,
  );
});
