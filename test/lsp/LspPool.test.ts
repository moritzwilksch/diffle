import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspUnavailableError } from '../../src/server/lsp/LspBridge.js';
import { LspPool, type LspPoolOptions } from '../../src/server/lsp/LspPool.js';
import type { LanguageId, LspStatus } from '../../src/shared/protocol.js';

const ROOT = '/repo';
const FAKE = join(import.meta.dirname, 'fake-lsp.mjs');
const files: Record<string, string> = {
  'a.py': 'import os\ndef f():\n    pass\n',
  'other.py': 'x = 1\ny = 2\nz = f()\n',
  'b.go': 'package main\nfunc f() {}\n',
  'c.txt': 'plain\n',
  'x.c': 'int main(void) { return 0; }\n',
  'y.cpp': 'int main() { return 0; }\n',
};

interface Started {
  pool: LspPool;
  statuses: LspStatus[];
  /** Document events per command, as the fake logs them: `open a.py v1`. */
  events: Map<string, string[]>;
}

function start(overrides: Partial<Record<LanguageId, string>>, extra: Partial<LspPoolOptions> = {}): Started {
  const statuses: LspStatus[] = [];
  const events = new Map<string, string[]>();
  const pool = new LspPool({
    root: ROOT,
    overrides,
    read: async (p) => files[p] ?? null,
    has: async (p) => p in files,
    onStatus: (s) => statuses.push(s),
    // Every override names a program the probe would not find, so the pool must not probe them.
    lookup: () => null,
    spawnProcess: (command) => {
      const log = events.get(command) ?? [];
      events.set(command, log);
      const child = spawn(process.execPath, [FAKE], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_LSP_ROOT: ROOT },
      });
      child.stderr.on('data', (d: Buffer) => log.push(...d.toString().split('\n').filter(Boolean)));
      return child;
    },
    ...extra,
  });
  pools.push(pool);
  return { pool, statuses, events };
}

const pools: LspPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

/** Notifications have no reply; let the fakes' stderr catch up. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('LspPool', () => {
  it('starts a server per language in the diff and opens each file in its own', async () => {
    const { pool, events } = start({ python: 'py-server', go: 'go-server' });
    expect(events.size).toBe(0);
    await pool.track(['a.py', 'b.go', 'c.txt']);
    await settle();
    expect(events.get('py-server')).toEqual(['open a.py v1']);
    expect(events.get('go-server')).toEqual(['open b.go v1']);
    // A language nothing serves never starts a process; servers come in language order.
    expect([...events.keys()]).toEqual(['go-server', 'py-server']);

    const res = await pool.definition({ path: 'a.py', line: 3, col: 4 });
    expect(res.locations).toEqual([{ path: 'a.py', line: 2, col: 4, text: 'def f():' }]);
    expect(await pool.hover({ path: 'b.go', line: 2, col: 5 })).toEqual({
      contents: '```python\ndef f() -> None\n```\n\nDoes the `f` thing.',
      range: { line: 2, col: 4, endLine: 2, endCol: 5 },
    });
  });

  it('routes by extension and says what is missing for a path it cannot serve', async () => {
    const { pool } = start({ python: 'py-server', rust: '' });
    await pool.track(['a.py', 'main.rs', 'main.go']);
    await expect(pool.definition({ path: 'c.txt', line: 1, col: 0 })).rejects.toThrow(
      /No language server for \.txt files/,
    );
    await expect(pool.definition({ path: 'b.go', line: 1, col: 0 })).rejects.toThrow(LspUnavailableError);
    // Asked for go, it names the programs to install; rust is off by config, so nothing to install.
    await expect(pool.documentSymbols('main.rs')).rejects.toThrow(/off in your diffle config/);
    await expect(pool.documentSymbols('main.go')).rejects.toThrow(/install one of gopls/);
  });

  it('reports every server and every unserved language as one status', async () => {
    const { pool, statuses } = start({ python: 'py-server', rust: '' });
    await pool.track(['a.py', 'main.rs', 'b.go']);
    await settle();
    const status = pool.status();
    expect(status.enabled).toBe(true);
    expect(status.servers).toMatchObject([
      { name: 'py-server', command: 'py-server', state: 'ready', languages: ['python'] },
    ]);
    expect(status.missing).toEqual([
      { language: 'go', tried: ['gopls'] },
      { language: 'rust', tried: [] },
    ]);
    // Every change, from resolution to readiness, reaches the listener as the whole pool's status.
    expect(statuses.at(-1)).toEqual(status);
    expect(statuses.some((s) => s.servers.every((x) => x.state === 'starting'))).toBe(true);
  });

  it('shares one process between languages whose command is the same', async () => {
    const { pool, events } = start({ c: 'clangd-ish', cpp: 'clangd-ish' });
    await pool.track(['x.c', 'y.cpp']);
    await settle();
    expect([...events.keys()]).toEqual(['clangd-ish']);
    expect(events.get('clangd-ish')?.sort()).toEqual(['open x.c v1', 'open y.cpp v1']);
    expect(pool.status().servers).toMatchObject([
      { name: 'clangd-ish', command: 'clangd-ish', state: 'ready', languages: ['c', 'cpp'] },
    ]);
  });

  it('asks every server for workspace symbols and keeps a server whose language left the diff', async () => {
    const { pool, events } = start({ python: 'py-server', go: 'go-server' });
    await pool.track(['a.py', 'b.go']);
    const symbols = await pool.workspaceSymbols('q');
    expect(symbols.map((s) => s.name)).toEqual(['q_sym', 'q_sym']);
    // A refresh that drops go keeps its server up, with nothing open.
    await pool.track(['a.py']);
    await settle();
    expect(pool.status().servers.map((s) => s.name)).toEqual(['go-server', 'py-server']);
    expect(events.get('go-server')).toEqual(['open b.go v1', 'close b.go']);
  });

  it('starts preloaded languages before any snapshot arrives', async () => {
    const { pool, events } = start({ python: 'py-server' }, { preload: ['python'] });
    expect([...events.keys()]).toEqual(['py-server']);
    expect(pool.status().servers.map((s) => s.state)).toEqual(['starting']);
    expect(await pool.tokenKind({ path: 'a.py', line: 1, col: 0 })).toEqual({ kind: 'keyword' });
  });

  it('has nothing to say once closed', async () => {
    const { pool, statuses } = start({ python: 'py-server' }, { preload: ['python'] });
    await pool.close();
    const seen = statuses.length;
    await pool.track(['a.py']);
    expect(statuses.length).toBe(seen);
    await expect(pool.definition({ path: 'a.py', line: 1, col: 0 })).rejects.toThrow(/shutting down/);
  });
});
