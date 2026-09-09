import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserConfigStore } from '../../src/server/UserConfig.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-config-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('UserConfigStore', () => {
  it('serializes overlapping writes and leaves no temp files', async () => {
    const store = await UserConfigStore.open(join(dir, 'cfg', 'config.json'));
    const results = await Promise.all([
      store.set({ contextLines: 1 }),
      store.set({ lspCommands: { python: 'x' } }),
      store.set({ contextLines: 9 }),
    ]);
    expect(results.map((r) => r.contextLines)).toEqual([1, 1, 9]);
    const expected = { contextLines: 9, lspCommands: { python: 'x' } };
    expect(store.get()).toMatchObject(expected);
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toMatchObject(expected);
    expect(await readdir(join(dir, 'cfg'))).toEqual(['config.json']);
    expect((await UserConfigStore.open(store.file)).get()).toMatchObject(expected);
  });

  it('keeps known languages, drops the rest, and adopts a legacy lspCommand as python', async () => {
    const file = join(dir, 'config.json');
    await writeFile(
      file,
      JSON.stringify({ lspCommand: 'pyrefly lsp', lspCommands: { go: ' gopls ', rust: '', nope: 'x' } }),
    );
    expect((await UserConfigStore.open(file)).get().lspCommands).toEqual({
      python: 'pyrefly lsp',
      go: 'gopls',
      rust: '',
    });
  });
});
