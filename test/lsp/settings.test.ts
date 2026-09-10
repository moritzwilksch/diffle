import { describe, expect, it, vi } from 'vitest';
import { configuration, defaultSettings, jsonSchemas } from '../../src/server/lsp/settings.js';

describe('schema settings', () => {
  it('answers ordered, nested and whole configuration requests without replacing TOML project settings', () => {
    const settings = defaultSettings(['yaml', 'toml']);
    expect(
      configuration(settings, {
        items: [
          { section: 'yaml.schemaStore.enable' },
          { section: 'tombi' },
          {},
          { section: 'evenBetterToml.schema.enabled' },
        ],
      }),
    ).toEqual([true, {}, settings, true]);
    expect(defaultSettings(['python'])).toEqual({});
  });

  it('passes catalog filename associations through and drops malformed entries', async () => {
    const association = {
      url: 'https://example.com/package.json',
      fileMatch: ['package.json', '!excluded/package.json'],
    };
    const fetchCatalog = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ schemas: [association, null, { url: 42 }, { url: 'file:///secret', fileMatch: ['*'] }] }),
      );
    expect(await jsonSchemas(fetchCatalog)).toEqual([association]);
    expect(fetchCatalog).toHaveBeenCalledWith('https://www.schemastore.org/api/json/catalog.json', {
      signal: expect.any(AbortSignal),
    });
  });

  it('keeps offline and malformed catalogs nonfatal', async () => {
    expect(await jsonSchemas(vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')))).toEqual([]);
    expect(
      await jsonSchemas(vi.fn<typeof fetch>().mockResolvedValue(new Response('unavailable', { status: 503 }))),
    ).toEqual([]);
    expect(await jsonSchemas(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ schemas: {} })))).toEqual([]);
  });
});
