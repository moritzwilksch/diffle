import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LspBridge, LspUnavailableError } from '../../src/server/lsp/LspBridge.js';
import type { LanguageId, LspProcessStatus } from '../../src/shared/protocol.js';

const ROOT = '/repo';
const FAKE = join(import.meta.dirname, 'fake-lsp.mjs');
const files: Record<string, string> = {
  'a.py': 'import os\ndef f():\n    pass\n',
  'other.py': 'x = 1\ny = 2\nz = f()\n',
  'w.py': 'w\n',
  'x.py': 'x\n',
  'y.py': 'y\n',
  'z.py': 'z\n',
};

function start(env: Record<string, string> = {}, root = ROOT, maxOpen?: number, languages?: LanguageId[]) {
  const statuses: LspProcessStatus[] = [];
  /** Document events the fake server logged: `open a.py v1`, `change a.py v2`, `close a.py`. */
  const events: string[] = [];
  /** Paths `read` was asked for, and the most reads in flight at once. */
  const reads: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const bridge = LspBridge.start({
    command: 'fake',
    languages,
    root,
    read: async (p) => {
      reads.push(p);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return files[p] ?? null;
    },
    has: async (p) => p in files,
    maxOpen,
    onStatus: (s) => statuses.push(s),
    spawnProcess: () => {
      const child = spawn(process.execPath, [FAKE], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_LSP_ROOT: root, ...env },
      });
      child.stderr.on('data', (d: Buffer) => events.push(...d.toString().split('\n').filter(Boolean)));
      return child;
    },
  });
  return { bridge, statuses, events, reads, peak: () => peak };
}

/** Notifications have no reply; let the fake's stderr catch up. */
const settle = () => new Promise((r) => setTimeout(r, 50));

const tmpdirs: string[] = [];
afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('LspBridge', () => {
  it('delivers JSON catalog settings through notifications and server configuration requests', async () => {
    const schemas = [{ url: 'https://example.com/package.json', fileMatch: ['package.json'] }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ schemas })));
    const { bridge, events } = start({ FAKE_LSP_CONFIG: '1' }, ROOT, undefined, ['json']);
    try {
      await vi.waitFor(() => expect(events).toContain(`config ${JSON.stringify([{ schemas }, {}])}`));
      expect(events).toContain('protocols file,http,https');
      expect(bridge.status().state).toBe('ready');
    } finally {
      await bridge.close();
      vi.unstubAllGlobals();
    }
  });

  it('maps definitions to snapshot paths and drops results it can read nowhere', async () => {
    const { bridge, statuses } = start();
    const res = await bridge.definition({ path: 'a.py', line: 3, col: 4 });
    // The fake also points at /usr/lib/python3/site.py, which is neither in the snapshot nor on disk.
    expect(res).toEqual({ locations: [{ path: 'a.py', line: 2, col: 4, text: 'def f():' }] });
    expect(statuses.map((s) => s.state)).toEqual(['ready']);
    expect(bridge.status().state).toBe('ready');
    await bridge.close();
  });

  it('serves a file outside the root from disk once a result named it, and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffle-lsp-'));
    tmpdirs.push(dir);
    const site = join(dir, 'site.py');
    const secret = join(dir, 'secret.py');
    writeFileSync(site, 'import sys\n');
    writeFileSync(secret, 'token = 1\n');
    const { bridge } = start({ FAKE_LSP_EXTERNAL: site });
    expect(await bridge.readExternal(site)).toBeNull();
    const res = await bridge.definition({ path: 'a.py', line: 3, col: 4 });
    expect(res.locations).toEqual([
      { path: 'a.py', line: 2, col: 4, text: 'def f():' },
      { path: site, line: 1, col: 0, text: 'import sys', external: true },
    ]);
    expect((await bridge.readExternal(site))?.toString()).toBe('import sys\n');
    // A readable file the server never returned stays behind the snapshot allowlist.
    expect(await bridge.readExternal(secret)).toBeNull();
    rmSync(site);
    expect(await bridge.readExternal(site)).toBeNull();
    await bridge.close();
  });

  it('reads a file inside the root that the snapshot hides from disk and marks it external', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'diffle-lsp-')));
    tmpdirs.push(root);
    writeFileSync(join(root, 'ignored.py'), 'VENV = True\n');
    const { bridge } = start({}, root);
    const res = await bridge.references({ path: 'a.py', line: 1, col: 0 });
    expect(res.locations.at(-1)).toEqual({
      path: join(root, 'ignored.py'),
      line: 1,
      col: 0,
      text: 'VENV = True',
      external: true,
    });
    expect((await bridge.readExternal(join(root, 'ignored.py')))?.toString()).toBe('VENV = True\n');
    await bridge.close();
  });

  it('classifies the token at a position from semantic tokens, and has no opinion without them', async () => {
    const { bridge } = start();
    // a.py line 1: `import os`
    expect(await bridge.tokenKind({ path: 'a.py', line: 1, col: 0 })).toEqual({ kind: 'keyword' });
    expect(await bridge.tokenKind({ path: 'a.py', line: 1, col: 5 })).toEqual({ kind: 'keyword' });
    expect(await bridge.tokenKind({ path: 'a.py', line: 1, col: 7 })).toEqual({ kind: 'variable' });
    expect(await bridge.tokenKind({ path: 'a.py', line: 1, col: 6 })).toEqual({ kind: null });
    expect(await bridge.tokenKind({ path: 'a.py', line: 3, col: 4 })).toEqual({ kind: 'keyword' });
    await bridge.close();
    const plain = start({ FAKE_LSP_NO_TOKENS: '1' });
    expect(await plain.bridge.tokenKind({ path: 'a.py', line: 1, col: 0 })).toEqual({ kind: null });
    await plain.bridge.close();
  });

  it('shapes hover contents into markdown with the range in snapshot units, and null when the server has nothing', async () => {
    const { bridge } = start();
    expect(await bridge.hover({ path: 'a.py', line: 2, col: 4 })).toEqual({
      contents: '```python\ndef f() -> None\n```\n\nDoes the `f` thing.',
      range: { line: 2, col: 4, endLine: 2, endCol: 5 },
    });
    expect(await bridge.hover({ path: 'a.py', line: 1, col: 0 })).toEqual({ contents: null });
    await bridge.close();
  });

  it("rewrites the hover text's file links to in-app jumps, and drops the ones outside the root", async () => {
    const { bridge } = start({ FAKE_LSP_HOVER_LINKS: '1' });
    expect(await bridge.hover({ path: 'a.py', line: 2, col: 4 })).toEqual({
      contents: 'Go to [f](diffle:a.py#L3) or site',
    });
    await bridge.close();
  });

  it('matches URIs the server canonicalized when the root is reached through a symlink', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diffle-lsp-')));
    tmpdirs.push(dir);
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    mkdirSync(real);
    writeFileSync(join(real, 'a.py'), files['a.py']!);
    symlinkSync(real, link);
    const { bridge } = start({ FAKE_LSP_REAL_ROOT: real }, link);
    const res = await bridge.definition({ path: 'a.py', line: 3, col: 4 });
    expect(res.locations).toEqual([{ path: 'a.py', line: 2, col: 4, text: 'def f():' }]);
    await bridge.close();
  });

  it('opens the document with snapshot text, updates it on change, and drops paths the snapshot hides', async () => {
    const { bridge } = start();
    const first = await bridge.references({ path: 'a.py', line: 1, col: 0 });
    expect(first.locations.map((l) => [l.path, l.line, l.col])).toEqual([
      ['a.py', 1, files['a.py']!.length],
      ['other.py', 3, 0],
    ]);
    // ignored.py sits in the root but the snapshot does not expose it, and /repo is not on disk.
    expect(first.locations).toHaveLength(2);
    files['a.py'] = 'x\n';
    const second = await bridge.references({ path: 'a.py', line: 1, col: 0 });
    expect(second.locations[0]!.col).toBe(2);
    await bridge.close();
  });

  it('flattens hierarchical document symbols and filters workspace symbols to the snapshot', async () => {
    const { bridge } = start();
    expect(await bridge.documentSymbols('a.py')).toEqual([
      { name: 'Foo', kind: 5, container: undefined, path: 'a.py', line: 1, endLine: 4, col: 6 },
      { name: 'bar', kind: 6, container: 'Foo', path: 'a.py', line: 2, endLine: 3, col: 8 },
      { name: 'baz', kind: 12, container: undefined, path: 'a.py', line: 6, endLine: 7, col: 4 },
    ]);
    expect(await bridge.workspaceSymbols('q')).toEqual([
      { name: 'q_sym', kind: 12, container: 'mod', path: 'other.py', line: 5, endLine: 5, col: 2 },
    ]);
    await bridge.close();
  });

  it('decides workspace symbol membership without reading files, and reads reference files in parallel', async () => {
    const { bridge, reads, peak } = start();
    await bridge.workspaceSymbols('q');
    expect(reads).toEqual([]);
    // a.py is open; other.py and ignored.py are read once each, at the same time.
    await bridge.references({ path: 'a.py', line: 1, col: 0 });
    expect(reads.slice(1).sort()).toEqual(['ignored.py', 'other.py']);
    expect(peak()).toBe(2);
    await bridge.close();
  });

  it('tracks the snapshot: opens its files, re-syncs changed text, closes files that left, skips unreadable ones', async () => {
    const { bridge, events } = start();
    files['a.py'] = 'import os\ndef f():\n    pass\n';
    await bridge.track(['a.py', 'other.py', 'gone.py']);
    await settle();
    expect(events).toEqual(['open a.py v1', 'open other.py v1']);
    // A query on a tracked file reuses the open document instead of opening it again.
    await bridge.definition({ path: 'a.py', line: 1, col: 0 });
    // Dropped path: didClose. Changed text: one didChange. Same text: nothing.
    files['other.py'] = 'x = 2\n';
    await bridge.track(['other.py']);
    await settle();
    expect(events.slice(2)).toEqual(['close a.py', 'change other.py v2']);
    // The closed file reopens with the current text on the next query.
    await bridge.references({ path: 'a.py', line: 1, col: 0 });
    await settle();
    expect(events.slice(4)).toEqual(['open a.py v1']);
    await bridge.close();
  });

  it('a track pass and a query racing on one file open it once', async () => {
    const { bridge, events } = start();
    await Promise.all([bridge.track(['a.py']), bridge.definition({ path: 'a.py', line: 1, col: 0 })]);
    await settle();
    expect(events).toEqual(['open a.py v1']);
    await bridge.close();
  });

  it('closes the least recently used untracked documents past the cap and never a tracked one', async () => {
    const { bridge, events } = start({}, ROOT, 2);
    await bridge.track(['a.py']);
    for (const p of ['x.py', 'y.py', 'z.py']) await bridge.documentSymbols(p);
    await settle();
    expect(events).toEqual(['open a.py v1', 'open x.py v1', 'open y.py v1', 'open z.py v1', 'close x.py']);
    // Touching y.py makes z.py the oldest; a.py is tracked and exempt.
    await bridge.documentSymbols('y.py');
    await bridge.documentSymbols('w.py');
    await settle();
    expect(events.slice(5)).toEqual(['open w.py v1', 'close z.py']);
    await bridge.close();
  });

  it('track never rejects: a dead server leaves nothing tracked and queries still report unavailable', async () => {
    const { bridge } = start({ FAKE_LSP_DIE: '1' });
    await expect(bridge.track(['a.py'])).resolves.toBeUndefined();
    await expect(bridge.references({ path: 'a.py', line: 1, col: 0 })).rejects.toBeInstanceOf(LspUnavailableError);
    await bridge.close();
  });

  it('reports indexing from pyrefly-style stderr log lines, start and end', async () => {
    const { bridge, statuses } = start({ FAKE_LSP_INDEX: '1' });
    await bridge.definition({ path: 'a.py', line: 1, col: 0 });
    for (let i = 0; i < 50 && bridge.status().indexing !== false; i++) await settle();
    expect(statuses.map((s) => [s.state, s.indexing])).toEqual([
      ['ready', undefined],
      ['ready', true],
      ['ready', false],
    ]);
    await bridge.close();
  });

  it('re-asks a request the server refuses as stale, and reports an outage when it keeps refusing', async () => {
    // Two refusals, then the answer: a document change racing a query must not surface as a failure.
    const one = start({ FAKE_LSP_MODIFIED: '2' });
    const res = await one.bridge.definition({ path: 'a.py', line: 3, col: 4 });
    expect(res.locations).toEqual([{ path: 'a.py', line: 2, col: 4, text: 'def f():' }]);
    expect(one.events.filter((e) => e.startsWith('refused'))).toHaveLength(2);
    await one.bridge.close();

    const many = start({ FAKE_LSP_MODIFIED: '99' });
    await expect(many.bridge.references({ path: 'a.py', line: 1, col: 0 })).rejects.toThrow(/kept changing; try again/);
    // Three attempts, then it stops asking; the server is still up for the next query.
    expect(many.events.filter((e) => e.startsWith('refused'))).toHaveLength(3);
    expect(many.bridge.status().state).toBe('ready');
    await many.bridge.close();
  });

  it('reports unavailable when the server dies during initialize', async () => {
    const { bridge, statuses } = start({ FAKE_LSP_DIE: '1' });
    await expect(bridge.definition({ path: 'a.py', line: 1, col: 0 })).rejects.toBeInstanceOf(LspUnavailableError);
    expect(bridge.status().state).toBe('unavailable');
    expect(statuses.at(-1)?.message).toMatch(/exited|initialize failed/);
    await bridge.close();
  });
});
