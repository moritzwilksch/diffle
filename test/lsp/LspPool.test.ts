import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LspUnavailableError } from '../../src/server/lsp/LspBridge.js';
import { LspPool, type LspPoolOptions, type TrackedSnapshot } from '../../src/server/lsp/LspPool.js';
import type { Workspace } from '../../src/server/lsp/LspWorkspace.js';
import type { ChangedFile, LanguageId, LspStatus } from '../../src/shared/protocol.js';

const ROOT = '/repo';
/** Where a snapshot whose new side is not the checkout gets served from. */
const CHECKOUT = '/checkout';
const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const FAKE = join(import.meta.dirname, 'fake-lsp.mjs');
const files: Record<string, string> = {
  'a.py': 'import os\ndef f():\n    pass\n',
  'other.py': 'x = 1\ny = 2\nz = f()\n',
  'b.go': 'package main\nfunc f() {}\n',
  'c.txt': 'plain\n',
  'x.c': 'int main(void) { return 0; }\n',
  'y.cpp': 'int main() { return 0; }\n',
};

/** A snapshot of changed `paths`; its new side is HEAD unless `newSha` says otherwise. */
function snap(paths: string[], newSha = HEAD): TrackedSnapshot {
  return {
    newSha,
    headSha: HEAD,
    changed: paths.map((path) => ({ path, status: 'M', binary: false }) as ChangedFile),
  };
}

/** Assigns the repository to a checkout snapshot and CHECKOUT to any other, like LspWorkspace. */
const workspace: Workspace = {
  rootFor: async (s) => (s.newSha === s.headSha ? ROOT : CHECKOUT),
  close: async () => {},
};

interface Started {
  pool: LspPool;
  statuses: LspStatus[];
  /** Document events per command, as the fake logs them: `open a.py v1`; a server outside ROOT is keyed `command@cwd`. */
  events: Map<string, string[]>;
}

function start(overrides: Partial<Record<LanguageId, string>>, extra: Partial<LspPoolOptions> = {}): Started {
  const statuses: LspStatus[] = [];
  const events = new Map<string, string[]>();
  const pool = new LspPool({
    workspace,
    preloadRoot: ROOT,
    overrides,
    read: async (p) => files[p] ?? null,
    has: async (p) => p in files,
    onStatus: (s) => statuses.push(s),
    // Every override names a program the probe would not find, so the pool must not probe them.
    lookup: () => null,
    spawnProcess: (command, cwd) => {
      const key = cwd === ROOT ? command : `${command}@${cwd}`;
      const log = events.get(key) ?? [];
      events.set(key, log);
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
    await pool.track(snap(['a.py', 'b.go', 'c.txt']));
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
    await pool.track(snap(['a.py', 'main.rs', 'main.go']));
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
    await pool.track(snap(['a.py', 'main.rs', 'b.go']));
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
    await pool.track(snap(['x.c', 'y.cpp']));
    await settle();
    expect([...events.keys()]).toEqual(['clangd-ish']);
    expect(events.get('clangd-ish')?.sort()).toEqual(['open x.c v1', 'open y.cpp v1']);
    expect(pool.status().servers).toMatchObject([
      { name: 'clangd-ish', command: 'clangd-ish', state: 'ready', languages: ['c', 'cpp'] },
    ]);
  });

  it('asks every server for workspace symbols and keeps a server whose language left the diff', async () => {
    const { pool, events } = start({ python: 'py-server', go: 'go-server' });
    await pool.track(snap(['a.py', 'b.go']));
    const symbols = await pool.workspaceSymbols('q');
    expect(symbols.map((s) => s.name)).toEqual(['q_sym', 'q_sym']);
    // A refresh that drops go keeps its server up, with nothing open.
    await pool.track(snap(['a.py']));
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

  it('serves a snapshot whose new side is not the checkout from the root the workspace assigns', async () => {
    const { pool, events, statuses } = start({ python: 'py-server' });
    await pool.track(snap(['a.py']));
    await pool.track(snap(['a.py', 'other.py'], OLDER));
    await settle();
    // A second server, in the checkout; the repository's keeps its document and stays out of the status.
    expect([...events.keys()]).toEqual(['py-server', `py-server@${CHECKOUT}`]);
    expect(events.get(`py-server@${CHECKOUT}`)).toEqual(['open a.py v1', 'open other.py v1']);
    expect(events.get('py-server')).toEqual(['open a.py v1']);
    expect(pool.status().servers).toMatchObject([{ name: 'py-server', state: 'ready', languages: ['python'] }]);
    expect(statuses.filter((s) => s.servers.some((x) => x.state === 'starting')).length).toBeGreaterThan(1);
    // Queries go to the checkout's server: the fake echoes the length of the text it holds open.
    const refs = await pool.references({ path: 'other.py', line: 1, col: 0 });
    expect(refs.locations[0]).toMatchObject({ path: 'other.py', col: files['other.py']!.length });

    // Back at the checkout: the first server is still up, and re-synced from the snapshot.
    await pool.track(snap(['other.py']));
    await settle();
    expect([...events.keys()]).toHaveLength(2);
    expect(events.get('py-server')).toEqual(['open a.py v1', 'close a.py', 'open other.py v1']);
  });

  it('answers a query only after the root switch it waits for', async () => {
    let release!: (dir: string) => void;
    const pending = new Promise<string>((res) => (release = res));
    const slow: Workspace = { rootFor: () => pending, close: async () => {} };
    const { pool, events } = start({ python: 'py-server' }, { workspace: slow });
    const tracked = pool.track(snap(['a.py'], OLDER));
    const answer = pool.definition({ path: 'a.py', line: 3, col: 4 });
    await settle();
    expect(events.size).toBe(0);
    release(CHECKOUT);
    await tracked;
    expect((await answer).locations).toEqual([{ path: 'a.py', line: 2, col: 4, text: 'def f():' }]);
  });

  it('reports a checkout that failed as the blocker until a snapshot gets one', async () => {
    let fail = true;
    const flaky: Workspace = {
      rootFor: async () => {
        if (fail) throw new Error('git worktree add failed: disk full');
        return CHECKOUT;
      },
      close: async () => {},
    };
    const { pool, statuses } = start({ python: 'py-server' }, { workspace: flaky });
    await pool.track(snap(['a.py'], OLDER));
    const blocker = 'No checkout for the language servers: git worktree add failed: disk full';
    expect(pool.status()).toMatchObject({ servers: [], blocker });
    expect(statuses.at(-1)).toEqual(pool.status());
    await expect(pool.definition({ path: 'a.py', line: 1, col: 0 })).rejects.toThrow(blocker);
    await expect(pool.workspaceSymbols('q')).rejects.toThrow(blocker);
    fail = false;
    await pool.track(snap(['a.py'], OLDER));
    expect(pool.status().blocker).toBeUndefined();
    expect(pool.status().servers).toHaveLength(1);
    expect(await pool.tokenKind({ path: 'a.py', line: 1, col: 0 })).toEqual({ kind: 'keyword' });
  });

  it('closes the workspace after the servers running in it', async () => {
    const order: string[] = [];
    const ws: Workspace = {
      rootFor: async () => CHECKOUT,
      close: async () => {
        order.push('workspace');
      },
    };
    const { pool } = start({ python: 'py-server' }, { workspace: ws });
    await pool.track(snap(['a.py'], OLDER));
    const bridgeClose = pool.status().servers.length;
    expect(bridgeClose).toBe(1);
    await pool.close();
    expect(order).toEqual(['workspace']);
    await expect(pool.definition({ path: 'a.py', line: 1, col: 0 })).rejects.toThrow(/shutting down/);
  });

  it('has nothing to say once closed', async () => {
    const { pool, statuses } = start({ python: 'py-server' }, { preload: ['python'] });
    await pool.close();
    const seen = statuses.length;
    await pool.track(snap(['a.py']));
    expect(statuses.length).toBe(seen);
    await expect(pool.definition({ path: 'a.py', line: 1, col: 0 })).rejects.toThrow(/shutting down/);
  });
});
