import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';
import { UserConfigStore } from '../../src/server/UserConfig.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-config-'));
});
afterEach(() => rmTmp(dir));

describe('UserConfigStore', () => {
  it('serializes overlapping writes and leaves no temp files', async () => {
    const store = await UserConfigStore.open(join(dir, 'cfg', 'config.json'));
    const results = await Promise.all([
      store.set({ contextLines: 1 }),
      store.set({ lspCommand: 'x' }),
      store.set({ contextLines: 9 }),
    ]);
    expect(results.map((r) => r.contextLines)).toEqual([1, 1, 9]);
    expect(store.get()).toMatchObject({ contextLines: 9, lspCommand: 'x' });
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toMatchObject({ contextLines: 9, lspCommand: 'x' });
    expect(await readdir(join(dir, 'cfg'))).toEqual(['config.json']);
    expect((await UserConfigStore.open(store.file)).get()).toMatchObject({ contextLines: 9, lspCommand: 'x' });
  });
});
