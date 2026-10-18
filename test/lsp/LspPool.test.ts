import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { LspUnavailableError } from '@/server/lsp/LspProcess.js';
import { LspPool, type LspPoolOptions } from '@/server/lsp/LspPool.js';
import type { LanguageId, LspStatus } from '@/shared/protocol.js';
import { flush } from './flush.js';

/** A worktree snapshot changing `paths`. */
const diff = (...paths: string[]) => ({
  newSha: 'worktree',
  headSha: '',
  changed: paths.map((path) => ({ path, status: 'M' as const, binary: false })),
});

const ROOT = '/repo';
const FAKE = join(import.meta.dirname, 'fake-lsp.mjs');
const files: Record<string, string> = {
  'a.py': 'import os\ndef f():\n    pass\n',
  'other.py': 'x = 1\ny = 2\nz = f()\n',
  'b.go': 'package main\nfunc f() {}\n',
  'c.txt': 'plain\n',
  'x.c': 'int main(void) { return 0; }\n',
  'y.cpp': 'int main() { return 0; }\n',
  'a.tsx': 'const f = 1;\nf;\nf;\n\nexport {};\n',
  'b.js': 'f();\nf();\n',
};

interface Started {
  pool: LspPool;
  statuses: LspStatus[];
  /** Document events per command, as the fake logs them: `open a.py v1`. */
  events: Map<string, string[]>;
  /** Waits until every fake has logged the document events sent so far. */
  settle: () => Promise<void>;
}

function start(overrides: Partial<Record<LanguageId, string>>, extra: Partial<LspPoolOptions> = {}): Started {
  const statuses: LspStatus[] = [];
  const events = new Map<string, string[]>();
  const children: { stdin: Writable; log: string[] }[] = [];
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
      children.push({ stdin: child.stdin, log });
      return child;
    },
    ...extra,
  });
  pools.push(pool);
  const settle = () => Promise.all(children.map((c) => flush(c, c.log))).then(() => {});
  return { pool, statuses, events, settle };
}

const pools: LspPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

describe('LspPool', () => {
  it('starts a server per language in the diff and opens each file in its own', async () => {
    const { pool, events, settle } = start({ python: 'py-server', go: 'go-server' });
    expect(events.size).toBe(0);
    await pool.track(diff('a.py', 'b.go', 'c.txt'));
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

  it('routes by extension and refuses a path it cannot serve', async () => {
    const { pool } = start({ python: 'py-server', rust: '' });
    await pool.track(diff('a.py', 'main.rs', 'main.go'));
    // The route words why through lspBlocker before asking; the pool only refuses.
    await expect(pool.definition({ path: 'c.txt', line: 1, col: 0 })).rejects.toThrow(LspUnavailableError);
    await expect(pool.definition({ path: 'b.go', line: 1, col: 0 })).rejects.toThrow(LspUnavailableError);
    await expect(pool.documentSymbols('main.rs')).rejects.toThrow(LspUnavailableError);
    await expect(pool.documentSymbols('main.go')).rejects.toThrow(/no language server for main\.go/);
  });

  it('reports every server and every unserved language as one status', async () => {
    const { pool, statuses, settle } = start({ python: 'py-server', rust: '' });
    await pool.track(diff('a.py', 'main.rs', 'b.go'));
    await settle();
    const status = pool.status();
    expect(status.enabled).toBe(true);
    expect(status.servers).toMatchObject([
      {
        name: 'py-server',
        command: 'py-server',
        state: 'ready',
        languages: ['python'],
        supports: [
          'definition',
          'typeDefinition',
          'hover',
          'references',
          'documentSymbol',
          'workspaceSymbol',
          'documentHighlight',
        ],
      },
    ]);
    expect(status.missing).toEqual([
      { language: 'go', tried: ['gopls'] },
      { language: 'rust', tried: [] },
    ]);
    // Every change, from resolution to readiness, reaches the listener as the whole pool's status.
    expect(statuses.at(-1)).toEqual(status);
    expect(statuses.some((s) => s.servers.every((x) => x.state === 'starting'))).toBe(true);
  });

  it('hands a language that arrives later to the process already running its command', async () => {
    const { pool, events, settle } = start({ c: 'clangd-ish', cpp: 'clangd-ish' });
    await pool.track(diff('x.c'));
    await pool.track(diff('x.c', 'y.cpp'));
    await settle();
    expect([...events.keys()]).toEqual(['clangd-ish']);
    expect(events.get('clangd-ish')?.sort()).toEqual(['open x.c v1', 'open y.cpp v1']);
    expect(pool.status().servers).toMatchObject([
      { name: 'clangd-ish', command: 'clangd-ish', state: 'ready', languages: ['c', 'cpp'] },
    ]);
  });

  it('asks every server for workspace symbols and keeps a server whose language left the diff', async () => {
    const { pool, events, settle } = start({ python: 'py-server', go: 'go-server' });
    await pool.track(diff('a.py', 'b.go'));
    const { symbols } = await pool.workspaceSymbols('q');
    expect(symbols.map((s) => s.name)).toEqual(['q_sym', 'q_sym']);
    // A refresh that drops go keeps its server up, with nothing open.
    await pool.track(diff('a.py'));
    await settle();
    expect(pool.status().servers.map((s) => s.name)).toEqual(['go-server', 'py-server']);
    expect(events.get('go-server')).toEqual(['open b.go v1', 'close b.go']);
  });

  it('starts preloaded languages before any snapshot arrives', async () => {
    const { pool, events } = start({ python: 'py-server' }, { preload: ['python'] });
    expect([...events.keys()]).toEqual(['py-server']);
    expect(pool.status().servers.map((s) => s.state)).toEqual(['starting']);
    expect((await pool.hover({ path: 'a.py', line: 2, col: 4 })).contents).toContain('def f()');
  });

  describe('a server joining languages beside their owner', () => {
    const TAILWIND = 'tailwindcss-language-server --stdio';
    /** PATH holds Tailwind alone; the tagged fake stands in for it, and `env` tunes one command's fake. */
    const overlay = (
      overrides: Partial<Record<LanguageId, string>>,
      env: Record<string, Record<string, string>> = {},
    ) =>
      start(overrides, {
        lookup: (c) => (c.startsWith('tailwindcss-language-server') ? '/usr/bin/tailwindcss-language-server' : null),
        spawnProcess: (command) =>
          spawn(process.execPath, [FAKE], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              FAKE_LSP_ROOT: ROOT,
              ...(command === TAILWIND ? { FAKE_LSP_TAG: 'tailwind' } : {}),
              ...env[command],
            },
          }),
      });
    const ownerHover = {
      contents: '```python\ndef f() -> None\n```\n\nDoes the `f` thing.',
      range: { line: 2, col: 4, endLine: 2, endCol: 5 },
    };

    it('starts for a joined language and merges its hovers and locations after the owner’s', async () => {
      const { pool } = overlay({ typescriptreact: 'ts-server' });
      await pool.track(diff('a.tsx'));
      expect(pool.status().servers).toMatchObject([
        { command: 'ts-server', languages: ['typescriptreact'], joins: [] },
        { command: TAILWIND, languages: [], joins: ['typescriptreact'] },
      ]);
      expect(await pool.hover({ path: 'a.tsx', line: 2, col: 0 })).toEqual({
        ...ownerHover,
        contents: `${ownerHover.contents}\n\n---\n\ntailwind says hi`,
      });
      expect((await pool.definition({ path: 'a.tsx', line: 2, col: 0 })).locations).toEqual([
        { path: 'a.tsx', line: 2, col: 4, text: 'f;' },
        { path: 'a.tsx', line: 5, col: 0, text: 'export {};' },
      ]);
      // Highlights come from the owner alone: the joined fake would double them.
      expect((await pool.occurrences({ path: 'a.tsx', line: 2, col: 0 })).occurrences).toHaveLength(1);
      // A language entering the diff later joins the running process, as an owner's would.
      await pool.track(diff('a.tsx', 'b.js'));
      expect(pool.status().servers.map((s) => [s.command, s.joins])).toEqual([
        ['ts-server', []],
        [TAILWIND, ['typescriptreact', 'javascript']],
      ]);
    });

    it('serves a language nothing owns by itself', async () => {
      const { pool } = overlay({});
      await pool.track(diff('b.js'));
      const status = pool.status();
      expect(status.servers.map((s) => s.command)).toEqual([TAILWIND]);
      expect(status.missing).toEqual([{ language: 'javascript', tried: ['typescript-language-server', 'vtsls'] }]);
      expect(await pool.hover({ path: 'b.js', line: 2, col: 0 })).toEqual({ contents: 'tailwind says hi' });
      expect((await pool.occurrences({ path: 'b.js', line: 2, col: 0 })).occurrences).toHaveLength(1);
    });

    it('keeps the owner’s answer when the joined server is gone, and the owner’s error when nothing answers', async () => {
      const { pool } = overlay({ typescriptreact: 'ts-server' }, { [TAILWIND]: { FAKE_LSP_DIE: '1' } });
      await pool.track(diff('a.tsx'));
      await expect.poll(() => pool.status().servers[1]?.state).toBe('unavailable');
      expect(await pool.hover({ path: 'a.tsx', line: 2, col: 0 })).toEqual(ownerHover);

      const dead = overlay({ typescriptreact: 'ts-server' }, { 'ts-server': { FAKE_LSP_DIE: '1' } });
      await dead.pool.track(diff('a.tsx'));
      await expect.poll(() => dead.pool.status().servers[0]?.state).toBe('unavailable');
      expect(await dead.pool.hover({ path: 'a.tsx', line: 2, col: 0 })).toEqual({ contents: 'tailwind says hi' });
      // Line 1 has no hover anywhere, so the owner's outage is why the answer may be incomplete.
      expect(await dead.pool.hover({ path: 'a.tsx', line: 1, col: 0 })).toEqual({
        contents: null,
        inconclusive: expect.stringContaining('"ts-server" exited'),
      });
    });
  });

  it('tracks nothing when the new side is not the checkout', async () => {
    const { pool, events, settle } = start({ python: 'py-server' });
    await pool.track({ ...diff('a.py'), newSha: 'abc123', headSha: 'def456' });
    await settle();
    expect(events.size).toBe(0);
    await pool.track({ ...diff('a.py'), newSha: 'abc123', headSha: 'abc123' });
    await settle();
    expect(events.get('py-server')).toEqual(['open a.py v1']);
  });

  it('hands out one server’s log by command', async () => {
    const { pool } = start({ python: 'py-server' });
    await pool.track(diff('a.py'));
    await expect.poll(() => pool.log('py-server')?.map((e) => e.message)).toContain('open a.py v1');
    expect(pool.log('go-server')).toBeNull();
  });

  it('has nothing to say once closed', async () => {
    const { pool, statuses } = start({ python: 'py-server' }, { preload: ['python'] });
    await pool.close();
    const seen = statuses.length;
    await pool.track(diff('a.py'));
    expect(statuses.length).toBe(seen);
    await expect(pool.definition({ path: 'a.py', line: 1, col: 0 })).rejects.toThrow(/shutting down/);
  });
});
