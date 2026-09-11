import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubMetadata,
  ChangedFile,
  CommentThread,
  LspServerStatus,
  LspStatus,
  Snapshot,
  UserConfig,
  ViewedEntry,
} from '../../src/shared/protocol.js';

/** One python server in `state`; LSP_OFF is a run started with --no-lsp. */
const lspStatus = (state: LspServerStatus['state'], extra: Partial<LspServerStatus> = {}): LspStatus => ({
  enabled: true,
  servers: [{ name: 'pyrefly', command: 'pyrefly lsp', state, languages: ['python'], ...extra }],
  missing: [],
});
const LSP_OFF: LspStatus = { enabled: false, servers: [], missing: [] };

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const api = {
  github: vi.fn(),
  snapshot: vi.fn(),
  threads: vi.fn(async (): Promise<CommentThread[]> => []),
  viewed: vi.fn(async (): Promise<ViewedEntry[]> => []),
  config: vi.fn(async (): Promise<UserConfig> => ({
    autoViewed: [],
    contextLines: 5,
    lspCommands: { python: 'pyrefly lsp' },
  })),
  lspStatus: vi.fn(async (): Promise<LspStatus> => LSP_OFF),
  lspDefinition: vi.fn(),
  lspTypeDefinition: vi.fn(),
  lspReferences: vi.fn(),
  lspHover: vi.fn(),
  lspTokenKind: vi.fn(),
  lspSymbols: vi.fn(),
  switchMode: vi.fn(),
  file: vi.fn(),
  patch: vi.fn(),
  patches: vi.fn(),
  setResolved: vi.fn(),
  reply: vi.fn(),
  search: vi.fn(),
  setViewed: vi.fn(),
  setViewedBulk: vi.fn(),
  saveConfig: vi.fn(),
  exportToGithub: vi.fn(),
};
vi.mock('../../src/client/api.js', () => ({ api }));
const { blocksSymbol } = vi.hoisted(() => ({ blocksSymbol: vi.fn() }));
vi.mock('../../src/client/lsp/syntax.js', () => ({ blocksSymbol }));

const { useStore, TOAST_MS, WORKSPACE_SYMBOL_DEBOUNCE_MS } = await import('../../src/client/store.js');
const {
  filterSymbols,
  viewedState,
  isCollapsed,
  itemIdOf,
  itemDeps,
  itemVersion,
  visibleThreads,
  OVERSIZED_LINES,
  PATCH_BATCH_LINES,
  PATCH_BATCH_FILES,
} = await import('../../src/client/model.js');
/** A one-line patch per path, so a `patches` mock can answer any batch. */
const patchesFor = (paths: string[]) =>
  paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n-x\n+y\n`).join('');
const { lspTarget } = await import('../../src/client/lsp/target.js');

function snap(version: number, key: string, tree: string[] = ['a.txt', 'b.txt']): Snapshot {
  return {
    root: '/r',
    mode: {
      old: 'HEAD',
      mergeBase: false,
      new: 'worktree',

      live: 'none',
      commentKey: key,
    },
    version,
    oldSha: 'x',
    newSha: 'worktree',
    headSha: 'h',
    context: 5,
    changed: [],
    tree,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.github.mockReset().mockImplementation(async () => ({
    version: useStore.getState().snapshot?.version,
    repository: 'o/r',
    pullRequest: null,
    reason: 'No matching pull request',
  }));
  blocksSymbol.mockReset().mockResolvedValue(false);
  useStore.setState({
    snapshot: null,
    loaded: {},
    fileView: null,
    contents: {},
    threads: [],
    viewed: [],
    error: null,
    showResolved: false,
    activePath: null,
    selection: null,
    draft: null,
    gens: {},
    jumps: [],
    jumpIndex: 0,
    collapsed: {},
  });
});

describe('client transitions', () => {
  it('J lands on a file whose patch has not arrived, instead of skipping it', async () => {
    const txt = (path: string, blob: string) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      blob,
      generated: false,
    });
    const changed = [txt('a.txt', 'b1'), txt('b.txt', 'b2'), txt('c.txt', 'b3')];
    const pending = deferred<string>();
    api.patches.mockResolvedValue(patchesFor(['a.txt', 'b.txt', 'c.txt']));
    api.patch.mockImplementation((path: string) =>
      path === 'a.txt' ? Promise.resolve(patchesFor(['a.txt'])) : pending.promise,
    );
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt', 'c.txt']), changed });
    await useStore.getState().refreshSnapshot();
    useStore.getState().moveFile('first');
    expect(useStore.getState().activePath).toBe('a.txt');
    useStore.getState().moveFile(1);
    const s = useStore.getState();
    expect(s.activePath).toBe('b.txt');
    // Header only until the patch lands; the scroll request names the item all the same.
    expect(s.scrollTarget).toEqual(expect.objectContaining({ id: expect.stringMatching(/^diff:b\.txt@/) }));
    useStore.getState().moveFile(1);
    expect(useStore.getState().activePath).toBe('c.txt');
    pending.resolve(patchesFor(['b.txt']));
  });

  it('j / k treat a collapsed header as one unit and enter it at the correct edge when opened', async () => {
    const txt = (path: string, blob: string) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 1,
      binary: false,
      blob,
      generated: false,
    });
    const changed = [txt('a.txt', 'b1'), txt('b.txt', 'b2'), txt('c.txt', 'b3')];
    const middle = `diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -10,3 +10,3 @@
 ten
-eleven
+ELEVEN
 twelve
`;
    api.patches.mockResolvedValue(patchesFor(['a.txt']) + middle + patchesFor(['c.txt']));
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt', 'c.txt']), changed });
    await useStore.getState().refreshSnapshot();
    useStore.setState({ collapsed: { 'b.txt': true } });

    useStore.getState().moveFile('first');
    useStore.getState().moveCursor(1);
    expect(useStore.getState()).toMatchObject({ activePath: 'b.txt', selection: null });
    useStore.getState().moveCursor(1);
    expect(useStore.getState().selection?.id).toMatch(/^diff:c\.txt@/);

    useStore.getState().moveCursor(-1);
    expect(useStore.getState()).toMatchObject({ activePath: 'b.txt', selection: null });
    useStore.getState().moveCursor(-1);
    expect(useStore.getState().selection?.id).toMatch(/^diff:a\.txt@/);

    useStore.getState().moveFile(1);
    useStore.getState().toggleCollapsed('b.txt');
    useStore.getState().moveCursor(1);
    expect(useStore.getState().selection).toMatchObject({
      id: expect.stringMatching(/^diff:b\.txt@/),
      range: { end: 10, endSide: 'additions' },
    });

    useStore.getState().moveFile(1);
    useStore.setState((s) => ({ collapsed: { ...s.collapsed, 'b.txt': true } }));
    useStore.getState().moveFile(-1);
    expect(useStore.getState()).toMatchObject({ activePath: 'b.txt', selection: null });
    useStore.getState().toggleCollapsed('b.txt');
    useStore.getState().moveCursor(-1);
    expect(useStore.getState().selection).toMatchObject({
      id: expect.stringMatching(/^diff:b\.txt@/),
      range: { end: 12, endSide: 'additions' },
    });
  });

  it('J / K walk past binary files, which have no rows and so no cursor', async () => {
    const bin = (path: string) => ({
      path,
      status: 'M' as const,
      additions: 0,
      deletions: 0,
      binary: true,
      blob: 'b0',
      generated: false,
    });
    const changed = [
      bin('a.gif'),
      bin('b.mp4'),
      { path: 'c.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue(patchesFor(['c.txt']));
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.gif', 'b.mp4', 'c.txt']), changed });
    await useStore.getState().refreshSnapshot();
    useStore.getState().moveFile('first');
    expect(useStore.getState().activePath).toBe('a.gif');
    expect(useStore.getState().selection).toBeNull();
    useStore.getState().moveFile(1);
    expect(useStore.getState().activePath).toBe('b.mp4');
    useStore.getState().moveFile(1);
    expect(useStore.getState().activePath).toBe('c.txt');
    expect(useStore.getState().selection?.id).toMatch(/^diff:c\.txt@/);
    useStore.getState().moveFile(-1);
    useStore.getState().moveFile(-1);
    expect(useStore.getState().activePath).toBe('a.gif');
  });

  it('a watcher refresh keeps the open draft, cursor and search; a mode switch drops them', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working'), changed });
    await useStore.getState().refreshSnapshot();
    const id = itemIdOf(useStore.getState(), 'a.txt');
    const sel = { id, range: { start: 1, side: 'additions' as const, end: 1, endSide: 'additions' as const } };
    useStore.setState({
      selection: sel,
      draft: { path: 'a.txt', selection: sel },
      jumps: [{ path: 'a.txt', side: 'new', line: 1 }],
      jumpIndex: 1,
    });

    api.snapshot.mockResolvedValueOnce({ ...snap(2, 'working'), changed });
    await useStore.getState().refreshSnapshot();
    let s = useStore.getState();
    expect(s.draft?.path).toBe('a.txt');
    expect(s.selection?.range.end).toBe(1);
    expect(s.jumps).toHaveLength(1);

    api.switchMode.mockResolvedValueOnce(snap(3, 'pr:abc', ['c.txt']));
    await useStore.getState().switchMode({ kind: 'pr' });
    s = useStore.getState();
    expect(s.draft).toBeNull();
    expect(s.selection).toBeNull();
    expect(s.jumps).toEqual([]);
  });

  it('a reloaded file moves the selection to its new item id', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working'), changed });
    await useStore.getState().refreshSnapshot();
    const before = itemIdOf(useStore.getState(), 'a.txt');
    useStore.setState({
      selection: { id: before, range: { start: 1, side: 'additions', end: 1, endSide: 'additions' } },
    });
    // Same path, new content: the patch is reloaded under a new generation.
    api.snapshot.mockResolvedValueOnce({ ...snap(2, 'working'), changed: [{ ...changed[0]!, blob: 'b2' }] });
    await useStore.getState().refreshSnapshot();
    const after = itemIdOf(useStore.getState(), 'a.txt');
    expect(after).not.toBe(before);
    expect(useStore.getState().selection?.id).toBe(after);
  });

  it('the old side moving alone reloads every patch and refetches an unchanged file view', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 1, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
    api.file.mockResolvedValue({ contents: 'one\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt']), changed });
    await useStore.getState().refreshSnapshot();
    await useStore.getState().openFullFile('b.txt');
    const before = itemIdOf(useStore.getState(), 'a.txt');
    const viewBefore = useStore.getState().fileView?.item;
    const viewFetches = () => api.file.mock.calls.filter((c) => c[0] === 'b.txt').length;
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(viewFetches()).toBe(1);

    // HEAD amended: the worktree, the blob and the line counts are unchanged, the old text is not.
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-z\n+y\n');
    api.file.mockResolvedValue({ contents: 'two\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(2, 'working', ['a.txt', 'b.txt']), oldSha: 'x2', changed });
    await useStore.getState().refreshSnapshot();
    const s = useStore.getState();
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(viewFetches()).toBe(2);
    expect(itemIdOf(s, 'a.txt')).not.toBe(before);
    expect(s.fileView?.item).not.toBe(viewBefore);
    expect((s.fileView!.item as { file: { contents: string } }).file.contents).toBe('two\n');
    expect(s.contents['b.txt']).toEqual({ new: 'two\n' });
  });

  it('a reloading file and file view stay on screen until the replacement lands', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
    ];
    const patch = (minus: string) =>
      `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-${minus}\n+y\n`;
    api.patch.mockResolvedValue(patch('x'));
    api.file.mockResolvedValue({ contents: 'one\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt']), changed });
    await useStore.getState().refreshSnapshot();
    const stale = useStore.getState().loaded['a.txt'] as { kind: 'diff'; fileDiff: unknown };
    const before = itemIdOf(useStore.getState(), 'a.txt');

    // The saved file's patch is slow: the old card stays, and the cursor can still land on it.
    const slow = deferred<string>();
    api.patch.mockReturnValueOnce(slow.promise);
    api.snapshot.mockResolvedValueOnce({
      ...snap(2, 'working', ['a.txt', 'b.txt']),
      changed: [{ ...changed[0]!, blob: 'b2' }],
    });
    const refresh = useStore.getState().refreshSnapshot();
    await new Promise((r) => setTimeout(r, 0));
    let s = useStore.getState();
    expect(s.snapshot?.version).toBe(2);
    expect(s.loaded['a.txt']).toEqual(expect.objectContaining({ kind: 'diff', fileDiff: stale.fileDiff }));
    expect(itemIdOf(s, 'a.txt')).toBe(before);
    s.moveFile('first');
    expect(useStore.getState().selection?.id).toBe(before);
    slow.resolve(patch('w'));
    await refresh;
    s = useStore.getState();
    expect((s.loaded['a.txt'] as typeof stale).fileDiff).not.toBe(stale.fileDiff);
    expect(itemIdOf(s, 'a.txt')).not.toBe(before);
    expect(s.selection?.id).toBe(itemIdOf(s, 'a.txt'));

    // Same for the file view: its item is replaced, never blanked.
    await useStore.getState().openFullFile('b.txt');
    const item = useStore.getState().fileView?.item;
    expect(item).toEqual(expect.objectContaining({ kind: 'file' }));
    const slowFile = deferred<{ contents: string; binary: boolean }>();
    api.file.mockReturnValueOnce(slowFile.promise);
    api.snapshot.mockResolvedValueOnce({
      ...snap(3, 'working', ['a.txt', 'b.txt']),
      oldSha: 'x2',
      changed: [{ ...changed[0]!, blob: 'b2' }],
    });
    const refresh2 = useStore.getState().refreshSnapshot();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().fileView?.item).toBe(item);
    slowFile.resolve({ contents: 'two\n', binary: false });
    await refresh2;
    expect((useStore.getState().fileView!.item as { file: { contents: string } }).file.contents).toBe('two\n');
  });

  it('hydrated diffs that land together commit as one store transaction', async () => {
    const changed = ['a.txt', 'b.txt', 'c.txt'].map((path) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 1,
      binary: false,
      blob: 'b1',
      generated: false,
    }));
    api.patches.mockImplementation(async (paths: string[]) => patchesFor(paths));
    api.file.mockResolvedValue({ contents: 'y\nrest\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt', 'c.txt']), changed });
    await useStore.getState().refreshSnapshot();
    const partial = useStore.getState().loaded;
    const ids = changed.map((f) => itemIdOf(useStore.getState(), f.path));
    let commits = 0;
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.loaded !== prev.loaded) commits++;
    });
    await new Promise((r) => setTimeout(r, 0));
    unsubscribe();
    const s = useStore.getState();
    expect(commits).toBe(1);
    for (const f of changed) {
      expect(s.loaded[f.path]).not.toBe(partial[f.path]);
      expect((s.loaded[f.path] as { fileDiff: { isPartial?: boolean } }).fileDiff.isPartial).toBeFalsy();
      expect(s.contents[f.path]).toEqual({ old: 'y\nrest\n', new: 'y\nrest\n' });
    }
    // Every hydrated file got a fresh renderer.
    expect(changed.map((f) => itemIdOf(s, f.path))).not.toEqual(ids);
    api.patches.mockReset();
  });

  it('a mode switch stops the hydration queue: no further file requests, and the batch in flight is aborted', async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
    const changed = paths.map((path) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 1,
      binary: false,
      blob: 'b1',
      generated: false,
    }));
    api.patches.mockImplementation(async (ps: string[]) => patchesFor(ps));
    const pending: Deferred<{ contents: string; binary: boolean }>[] = [];
    api.file.mockImplementation(() => {
      const d = deferred<{ contents: string; binary: boolean }>();
      pending.push(d);
      return d.promise;
    });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', paths), changed });
    await useStore.getState().refreshSnapshot();
    // Four files at a time, two sides each.
    expect(api.file).toHaveBeenCalledTimes(8);
    const signal = api.file.mock.calls[0]![2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().switchMode({ kind: 'pr' });
    expect(signal.aborted).toBe(true);
    for (const d of pending) d.resolve({ contents: 'y\nrest\n', binary: false });
    await new Promise((r) => setTimeout(r, 0));
    // The obsolete queue dequeued nothing more, and the stale results were not committed.
    expect(api.file).toHaveBeenCalledTimes(8);
    expect(useStore.getState().loaded).toEqual({});
    expect(useStore.getState().contents).toEqual({});
    api.patches.mockReset();
  });

  it('a refresh touching five of many files requests only those five', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const file = (path: string, blob: string) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 1,
      binary: false,
      blob,
      generated: false,
    });
    api.patches.mockImplementation(async (ps: string[]) => patchesFor(ps));
    api.file.mockResolvedValue({ contents: 'y\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', paths), changed: paths.map((p) => file(p, 'b1')) });
    await useStore.getState().refreshSnapshot();
    expect(Object.keys(useStore.getState().loaded)).toHaveLength(30);
    // The whole review went out in batches of at most PATCH_BATCH_FILES.
    expect(api.patches.mock.calls.length).toBe(Math.ceil(30 / PATCH_BATCH_FILES));
    for (const c of api.patches.mock.calls) expect((c[0] as string[]).length).toBeLessThanOrEqual(PATCH_BATCH_FILES);
    api.patches.mockClear();
    api.patch.mockClear();

    const touched = ['f03.txt', 'f07.txt', 'f12.txt', 'f20.txt', 'f29.txt'];
    api.snapshot.mockResolvedValueOnce({
      ...snap(2, 'working', paths),
      changed: paths.map((p) => file(p, touched.includes(p) ? 'b2' : 'b1')),
    });
    await useStore.getState().refreshSnapshot();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.patches).toHaveBeenCalledTimes(1);
    expect([...(api.patches.mock.calls[0]![0] as string[])].sort()).toEqual(touched);
    api.patches.mockReset();
  });

  it('a huge file rides its own batch behind the small ones; the active file goes first; an oversized diff waits to be asked for', async () => {
    const file = (path: string, lines: number) => ({
      path,
      status: 'M' as const,
      additions: lines,
      deletions: 0,
      binary: false,
      blob: 'b1',
      generated: false,
    });
    const changed = [
      file('a.txt', 1),
      file('big.txt', PATCH_BATCH_LINES + 1),
      file('c.txt', 1),
      file('d.txt', 1),
      file('huge.lock', OVERSIZED_LINES + 1),
      file('z.txt', 1),
    ];
    const order: string[][] = [];
    api.patches.mockImplementation(async (ps: string[]) => {
      order.push(ps);
      return patchesFor(ps);
    });
    api.patch.mockImplementation(async (p: string) => {
      order.push([p]);
      return patchesFor([p]);
    });
    api.file.mockResolvedValue({ contents: 'y\n', binary: false });
    useStore.setState({ activePath: 'z.txt' });
    api.snapshot.mockResolvedValueOnce({
      ...snap(
        1,
        'working',
        changed.map((f) => f.path),
      ),
      changed,
    });
    await useStore.getState().refreshSnapshot();
    expect(order).toEqual([['z.txt', 'a.txt', 'c.txt', 'd.txt'], ['big.txt']]);
    const s = useStore.getState();
    expect(s.loaded['big.txt']).toEqual(expect.objectContaining({ kind: 'diff' }));
    expect(s.loaded['huge.lock']).toEqual({ kind: 'oversized', lines: OVERSIZED_LINES + 1 });

    // zo on the oversized file fetches it; a refresh then keeps the loaded diff up to date.
    useStore.setState({ activePath: 'huge.lock' });
    useStore.getState().setCollapsedAtCursor(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(order.at(-1)).toEqual(['huge.lock']);
    expect(useStore.getState().loaded['huge.lock']).toEqual(expect.objectContaining({ kind: 'diff' }));
    order.length = 0;
    api.snapshot.mockResolvedValueOnce({
      ...snap(
        2,
        'working',
        changed.map((f) => f.path),
      ),
      changed: changed.map((f) => (f.path === 'huge.lock' ? { ...f, blob: 'b2' } : f)),
    });
    await useStore.getState().refreshSnapshot();
    expect(order).toEqual([['huge.lock']]);
    expect(useStore.getState().loaded['huge.lock']).toEqual(expect.objectContaining({ kind: 'diff' }));
    api.patches.mockReset();
    api.patch.mockReset();
  });

  it('hydration and the file view opening at once share one request per side; a failed load is retried by the next consumer', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 1, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
    const pending: Deferred<{ contents: string; binary: boolean }>[] = [];
    api.file.mockImplementation(() => {
      const d = deferred<{ contents: string; binary: boolean }>();
      pending.push(d);
      return d.promise;
    });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working'), changed });
    await useStore.getState().refreshSnapshot();
    expect(api.file.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['a.txt', 'old'],
      ['a.txt', 'new'],
    ]);
    const open = useStore.getState().openFullFile('a.txt');
    const quote = useStore.getState().loadFile('a.txt', 'new');
    // Both joined the hydration's new-side request instead of issuing their own.
    expect(api.file).toHaveBeenCalledTimes(2);
    pending[0]!.resolve({ contents: 'x\nrest\n', binary: false });
    pending[1]!.resolve({ contents: 'y\nrest\n', binary: false });
    await open;
    expect((await quote).contents).toBe('y\nrest\n');
    await new Promise((r) => setTimeout(r, 0));
    const s = useStore.getState();
    expect(s.fileView?.item).toEqual(expect.objectContaining({ kind: 'file' }));
    expect((s.loaded['a.txt'] as { fileDiff: { isPartial?: boolean } }).fileDiff.isPartial).toBeFalsy();
    expect(s.contents['a.txt']).toEqual({ old: 'x\nrest\n', new: 'y\nrest\n' });
    expect(api.file).toHaveBeenCalledTimes(2);

    // A rejected load is not cached: the next consumer asks again.
    const failing = useStore.getState().loadFile('b.txt', 'new');
    pending[2]!.reject(new Error('boom'));
    await expect(failing).rejects.toThrow('boom');
    void useStore.getState().loadFile('b.txt', 'new');
    expect(api.file).toHaveBeenCalledTimes(4);
    api.file.mockReset();
  });

  it('the file view shows one file in place of the diff list, survives a refresh of that file, and Ctrl+o returns', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
    api.file.mockResolvedValue({ contents: 'y\nz\nw\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt']), changed });
    await useStore.getState().refreshSnapshot();
    const diffId = itemIdOf(useStore.getState(), 'a.txt');
    useStore.getState().moveFile('first');
    expect(useStore.getState().selection?.id).toBe(diffId);

    await useStore.getState().openFullFile('a.txt');
    let s = useStore.getState();
    expect(s.fileView?.path).toBe('a.txt');
    expect(s.fileView?.item).toEqual(expect.objectContaining({ kind: 'file' }));
    // A fresh renderer under the file id; the diff list is not part of the nav model any more.
    expect(itemIdOf(s, 'a.txt')).toMatch(/^file:a\.txt@/);
    expect(itemIdOf(s, 'a.txt')).not.toBe(diffId);
    // Ctrl+o leaves the view and lands back on the diff position it was entered from.
    useStore.getState().jumpBack();
    await new Promise((r) => setTimeout(r, 0));
    s = useStore.getState();
    expect(s.fileView).toBeNull();
    expect(s.selection).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^diff:a\.txt@/),
        range: expect.objectContaining({ end: 1 }),
      }),
    );
    // Ctrl+i re-enters it.
    useStore.getState().jumpForward();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().fileView?.path).toBe('a.txt');

    // The cursor walks every line of the file, not just the hunk; J / K stay inside the view.
    s = useStore.getState();
    s.moveFile('first');
    s.moveCursorBy(2);
    expect(useStore.getState().selection?.range.end).toBe(3);
    useStore.getState().moveFile(1);
    expect(useStore.getState().activePath).toBe('a.txt');

    // The file changed on disk: the view is refetched, not left stale.
    api.file.mockResolvedValue({ contents: 'q\n', binary: false });
    api.snapshot.mockResolvedValueOnce({
      ...snap(2, 'working', ['a.txt', 'b.txt']),
      changed: [{ ...changed[0]!, blob: 'b2' }],
    });
    await useStore.getState().refreshSnapshot();
    expect((useStore.getState().fileView!.item as { file: { contents: string } }).file.contents).toBe('q\n');

    // The back button returns to the newest diff-side position.
    useStore.getState().closeFullFile();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().fileView).toBeNull();
    expect(useStore.getState().selection?.id).toMatch(/^diff:a\.txt@/);

    // A mode switch drops the view along with the rest of the mode's state.
    await useStore.getState().openFullFile('a.txt');
    api.switchMode.mockResolvedValueOnce(snap(4, 'pr:abc', ['c.txt']));
    await useStore.getState().switchMode({ kind: 'pr' });
    expect(useStore.getState().fileView).toBeNull();
  });

  it('an unchanged file opens in the file view, not in the diff list', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
    api.file.mockResolvedValue({ contents: 'one\ntwo\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt']), changed });
    await useStore.getState().refreshSnapshot();
    await useStore.getState().openFile('b.txt', 2);
    const s = useStore.getState();
    expect(s.fileView?.path).toBe('b.txt');
    expect(s.activePath).toBe('b.txt');
    expect(s.scrollTarget).toEqual(expect.objectContaining({ line: 2, align: 'eye' }));
    expect(Object.keys(s.loaded)).toEqual(['a.txt']);
    // Opening a changed file leaves the view for its diff.
    await useStore.getState().openFile('a.txt', 1, 'new');
    expect(useStore.getState().fileView).toBeNull();
    expect(useStore.getState().scrollTarget).toEqual(
      expect.objectContaining({ id: expect.stringMatching(/^diff:a\.txt@/), line: 1 }),
    );
  });

  it('file and line motions stop once on collapsed headers, independent of viewed state', async () => {
    const changed = ['a.txt', 'b.txt', 'c.txt'].map((path, i) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      blob: `b${i}`,
      generated: false,
    }));
    api.patches.mockResolvedValue(patchesFor(['a.txt', 'b.txt', 'c.txt']));
    api.viewed.mockResolvedValueOnce([{ path: 'c.txt', blob: 'b2', viewed: true }]);
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt', 'c.txt']), changed });
    await useStore.getState().boot();
    // Stop on explicitly collapsed b.txt although it is unviewed; c.txt stays navigable although it is viewed.
    useStore.setState({ collapsed: { 'b.txt': true, 'c.txt': false }, diffStyle: 'unified' });
    useStore.getState().moveFile('first');
    expect(useStore.getState().activePath).toBe('a.txt');
    useStore.getState().moveFile(1);
    expect(useStore.getState().activePath).toBe('b.txt');
    expect(useStore.getState().selection).toBeNull();
    useStore.getState().moveFile(1);
    expect(useStore.getState().activePath).toBe('c.txt');
    useStore.getState().moveFile(-1);
    expect(useStore.getState().activePath).toBe('b.txt');
    expect(useStore.getState().selection).toBeNull();
    useStore.getState().moveFile(-1);
    expect(useStore.getState().activePath).toBe('a.txt');

    // Down/up line motions likewise stop on the header, then continue across it on the next press.
    useStore.getState().moveCursor(1);
    useStore.getState().moveCursor(1);
    expect(useStore.getState().activePath).toBe('b.txt');
    expect(useStore.getState().selection).toBeNull();
    useStore.getState().moveCursor(1);
    expect(useStore.getState().activePath).toBe('c.txt');
    useStore.getState().moveCursor(-1);
    expect(useStore.getState().activePath).toBe('b.txt');
    expect(useStore.getState().selection).toBeNull();
    useStore.getState().moveCursor(-1);
    expect(useStore.getState().activePath).toBe('a.txt');
  });

  it('a slow first refresh never overwrites a faster second one', async () => {
    const slow = deferred<Snapshot>();
    const fast = deferred<Snapshot>();
    api.snapshot.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const first = useStore.getState().refreshSnapshot();
    const second = useStore.getState().refreshSnapshot();
    fast.resolve(snap(2, 'working'));
    await second;
    expect(useStore.getState().snapshot?.version).toBe(2);
    slow.resolve(snap(1, 'working'));
    await first;
    expect(useStore.getState().snapshot?.version).toBe(2);
  });

  it('a snapshot push that overtakes boot keeps the config and LSP status boot fetched', async () => {
    useStore.setState({
      config: { autoViewed: [], contextLines: 5, lspCommands: {} },
      lsp: LSP_OFF,
    });
    const slow = deferred<Snapshot>();
    api.snapshot.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(snap(2, 'working'));
    api.config.mockResolvedValueOnce({ autoViewed: ['*.lock'], contextLines: 9, lspCommands: {} });
    api.lspStatus.mockResolvedValueOnce(lspStatus('ready'));
    const boot = useStore.getState().boot();
    // The watcher pushes while boot's requests are in flight.
    await useStore.getState().refreshSnapshot();
    slow.resolve(snap(1, 'working'));
    await boot;
    const s = useStore.getState();
    expect(s.snapshot?.version).toBe(2);
    expect(s.config.contextLines).toBe(9);
    expect(s.lsp.servers[0]?.state).toBe('ready');
  });

  it('a mode switch whose push lands before the POST response fetches once and resets the composer via the push', async () => {
    useStore.setState({ snapshot: snap(1, 'working'), replyTo: 't1', editingId: 't1' });
    const post = deferred<Snapshot>();
    api.switchMode.mockReturnValueOnce(post.promise);
    const switching = useStore.getState().switchMode({ kind: 'pr' });
    // The server broadcasts the new version before its response returns.
    api.snapshot.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().refreshSnapshot(2);
    let s = useStore.getState();
    expect(s.snapshot?.mode.commentKey).toBe('pr:abc');
    expect(s.replyTo).toBeNull();
    expect(s.editingId).toBeNull();

    post.resolve(snap(2, 'pr:abc', ['c.txt']));
    await switching;
    // A late echo of the version the client holds starts nothing either.
    await useStore.getState().refreshSnapshot(2);
    s = useStore.getState();
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(api.threads).toHaveBeenCalledTimes(1);
    expect(api.viewed).toHaveBeenCalledTimes(1);
    expect(s.snapshot?.version).toBe(2);
  });

  it('a push naming the version a refresh is already fetching starts no second fetch', async () => {
    useStore.setState({ snapshot: snap(1, 'working') });
    const slow = deferred<Snapshot>();
    api.snapshot.mockReturnValueOnce(slow.promise);
    const first = useStore.getState().refreshSnapshot(2);
    await useStore.getState().refreshSnapshot(2);
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    slow.resolve(snap(2, 'working'));
    await first;
    expect(useStore.getState().snapshot?.version).toBe(2);
    // A newer version is fetched again.
    api.snapshot.mockResolvedValueOnce(snap(3, 'working'));
    await useStore.getState().refreshSnapshot(3);
    expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it("a push during a resync against a restarted server is not deduped against the old lifetime's version", async () => {
    useStore.setState({ snapshot: snap(50, 'working') });
    const slow = deferred<Snapshot>();
    // The restarted server is at v1; its watcher pushes v2 while the boot is in flight.
    api.snapshot.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(snap(2, 'working', ['c.txt']));
    const boot = useStore.getState().boot();
    await useStore.getState().refreshSnapshot(2);
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(useStore.getState().snapshot?.version).toBe(2);
    slow.resolve(snap(1, 'working'));
    await boot;
    expect(useStore.getState().snapshot?.version).toBe(2);
    expect(useStore.getState().snapshot?.tree).toEqual(['c.txt']);
  });

  it("a mode switch resolved by its push leaves the push's in-flight fetch owning the version", async () => {
    useStore.setState({ snapshot: snap(1, 'working') });
    const post = deferred<Snapshot>();
    api.switchMode.mockReturnValueOnce(post.promise);
    const switching = useStore.getState().switchMode({ kind: 'pr' });
    const slow = deferred<Snapshot>();
    api.snapshot.mockReturnValueOnce(slow.promise);
    const pushed = useStore.getState().refreshSnapshot(2);
    post.resolve(snap(2, 'pr:abc', ['c.txt']));
    await switching;
    // A duplicate push while the first is still fetching must start nothing.
    await useStore.getState().refreshSnapshot(2);
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    slow.resolve(snap(2, 'pr:abc', ['c.txt']));
    await pushed;
    expect(useStore.getState().snapshot?.version).toBe(2);
  });

  it('a resync after a reconnect catches up snapshot, threads and viewed marks and keeps the draft', async () => {
    const changed = [
      { path: 'a.txt', status: 'M' as const, additions: 1, deletions: 0, binary: false, blob: 'b1', generated: false },
    ];
    api.patch.mockResolvedValue('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n');
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working'), changed });
    await useStore.getState().boot();
    const id = itemIdOf(useStore.getState(), 'a.txt');
    const sel = { id, range: { start: 1, side: 'additions' as const, end: 1, endSide: 'additions' as const } };
    useStore.setState({ selection: sel, draft: { path: 'a.txt', selection: sel } });

    // While the socket was down: a save, a new thread and a viewed mark, with no push to announce them.
    api.snapshot.mockResolvedValueOnce({ ...snap(3, 'working'), changed: [{ ...changed[0]!, blob: 'b2' }] });
    api.threads.mockResolvedValueOnce([thread({ id: 'missed' })]);
    api.viewed.mockResolvedValueOnce([{ path: 'b.txt', blob: 'bb', viewed: true }]);
    await useStore.getState().boot();
    const s = useStore.getState();
    expect(s.snapshot?.version).toBe(3);
    expect(s.threads.map((t) => t.id)).toEqual(['missed']);
    expect(s.viewed).toEqual([{ path: 'b.txt', blob: 'bb', viewed: true }]);
    expect(s.draft?.path).toBe('a.txt');
    expect(itemIdOf(s, 'a.txt')).not.toBe(id);
  });

  it('a file load that finishes after a mode switch is discarded', async () => {
    useStore.setState({ snapshot: snap(1, 'working') });
    const file = deferred<{ path: string; contents: string; binary: boolean }>();
    api.file.mockReturnValueOnce(file.promise);
    const open = useStore.getState().openFile('a.txt');
    expect(useStore.getState().fileView).toEqual({
      path: 'a.txt',
      external: false,
      item: null,
      from: { position: null, activePath: null },
    });

    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().switchMode({ kind: 'pr' });
    expect(useStore.getState().snapshot?.mode.commentKey).toBe('pr:abc');
    expect(useStore.getState().fileView).toBeNull();

    file.resolve({ path: 'a.txt', contents: 'stale', binary: false });
    await open;
    expect(useStore.getState().fileView).toBeNull();
    expect(useStore.getState().contents['a.txt']).toBeUndefined();
  });

  it('a pushed thread refresh that raced a mode switch is dropped', async () => {
    useStore.setState({ snapshot: snap(1, 'working') });
    const stale = deferred<CommentThread[]>();
    api.threads.mockReturnValueOnce(stale.promise);
    const refresh = useStore.getState().refreshThreads();
    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().switchMode({ kind: 'pr' });
    stale.resolve([thread({ id: 'old-mode' })]);
    await refresh;
    expect(useStore.getState().threads).toEqual([]);
  });

  it('a github export reports what it did and only toasts what went wrong', async () => {
    useStore.setState({ snapshot: snap(1, 'review') });
    const res = (over: Partial<{ posted: number; updated: number; skipped: { id: string; reason: string }[] }>) => ({
      url: 'https://github.com/o/r/pull/7',
      posted: 0,
      updated: 0,
      review: 'existing' as const,
      skipped: [],
      ...over,
    });
    useStore.setState({ toast: null });
    api.exportToGithub.mockResolvedValueOnce(res({ posted: 2 }));
    expect(await useStore.getState().exportToGithub()).toBe('added');
    api.exportToGithub.mockResolvedValueOnce(res({ updated: 1 }));
    expect(await useStore.getState().exportToGithub()).toBe('updated');
    // Re-exporting an unchanged thread is the expected answer, not a warning.
    api.exportToGithub.mockResolvedValueOnce(res({ skipped: [{ id: 't', reason: 'already in the review' }] }));
    expect(await useStore.getState().exportToGithub(['t'])).toBe('unchanged');
    expect(useStore.getState().toast).toBeNull();
    api.exportToGithub.mockResolvedValueOnce(res({ posted: 1, skipped: [{ id: 's', reason: 'stale' }] }));
    expect(await useStore.getState().exportToGithub()).toBe('added');
    expect(useStore.getState().toast).toMatch(/Skipped 1 of 2 \(stale\)/);
    api.exportToGithub.mockRejectedValueOnce(new Error('nope'));
    expect(await useStore.getState().exportToGithub()).toBeNull();
    expect(useStore.getState().toast).toMatch(/nope/);
  });

  it('a failed mutation becomes a toast, not an unhandled rejection', async () => {
    useStore.setState({ snapshot: snap(1, 'working'), threads: [thread({ id: 't' })] });
    api.setResolved.mockRejectedValueOnce(new Error('boom'));
    await useStore.getState().setResolved('t', true);
    expect(useStore.getState().toast).toMatch(/Resolving failed: boom/);
  });

  it('every toast stays for TOAST_MS, and a new toast restarts the clock', () => {
    vi.useFakeTimers();
    try {
      useStore.getState().flash('first');
      vi.advanceTimersByTime(TOAST_MS - 1);
      expect(useStore.getState().toast).toBe('first');
      useStore.getState().flash('second');
      vi.advanceTimersByTime(TOAST_MS - 1);
      expect(useStore.getState().toast).toBe('second');
      vi.advanceTimersByTime(1);
      expect(useStore.getState().toast).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opening a path that left the tree reports instead of loading', async () => {
    useStore.setState({ snapshot: snap(1, 'working', ['a.txt']) });
    await useStore.getState().openFile('deleted.txt', 3, 'new');
    expect(api.file).not.toHaveBeenCalled();
    expect(useStore.getState().fileView).toBeNull();
    expect(useStore.getState().toast).toMatch(/no longer exists/);
  });
});

describe('mode picker', () => {
  it('opens configuration for modes 2–4 without switching', () => {
    for (const [entry, pane] of [
      [2, 'refs'],
      [3, 'commits'],
      [4, 'pr'],
    ] as const) {
      useStore.getState().pickModeEntry(entry);
      expect(useStore.getState().modeMenuOpen).toBe(true);
      expect(useStore.getState().modePane).toBe(pane);
    }
    expect(api.switchMode).not.toHaveBeenCalled();
    useStore.getState().setModeMenuOpen(false);
    expect(useStore.getState().modePane).toBeNull();
  });

  it('shortcut 1 compares HEAD to the worktree immediately', () => {
    api.switchMode.mockResolvedValue(snap(2, 'working'));
    useStore.getState().pickModeEntry(1);
    expect(api.switchMode).toHaveBeenLastCalledWith({ kind: 'working' });
    expect(useStore.getState().modeMenuOpen).toBe(false);
  });
});

describe('symbol navigation', () => {
  it.each(['json', 'jsonc', 'yaml', 'toml'] as const)(
    '%s keeps hover but does not offer symbol navigation',
    async (language) => {
      const path = `config.${language}`;
      const target = { path, side: 'new' as const, line: 1, col: 2, text: 'name' };
      useStore.setState({
        snapshot: snap(1, 'working', [path]),
        lsp: lspStatus('ready', { languages: [language] }),
        symbolMenu: null,
        hover: null,
      });
      const state = useStore.getState();
      await state.openSymbolMenu(target, 10, 20);
      await state.goToDefinition(target);
      await state.goToTypeDefinition(target);
      await state.findReferences(target);
      expect(useStore.getState().symbolMenu).toBeNull();
      expect(api.lspTokenKind).not.toHaveBeenCalled();
      expect(api.lspDefinition).not.toHaveBeenCalled();
      expect(api.lspTypeDefinition).not.toHaveBeenCalled();
      expect(api.lspReferences).not.toHaveBeenCalled();
      api.lspHover.mockResolvedValue({ contents: 'Schema description' });
      await state.requestHover(target, { left: 0, top: 0, bottom: 0 });
      expect(useStore.getState().hover?.contents).toBe('Schema description');
    },
  );
  const target = { path: 'a.py', side: 'new' as const, line: 3, col: 4, text: 'foo' };
  const ready = () => {
    useStore.setState({ snapshot: snap(1, 'working', ['a.py', 'b.py']), lsp: lspStatus('ready') });
    api.file.mockResolvedValue({ path: 'b.py', contents: 'x = 1\ny = 2\n', binary: false });
  };

  it('explains why navigation is blocked instead of calling the server', async () => {
    useStore.setState({ snapshot: snap(1, 'working', ['a.py']), lsp: LSP_OFF });
    await useStore.getState().goToDefinition(target);
    expect(api.lspDefinition).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toMatch(/--no-lsp/);
    useStore.setState({ lsp: lspStatus('ready') });
    await useStore.getState().goToDefinition({ ...target, side: 'old' });
    expect(api.lspDefinition).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toMatch(/new side/);
  });

  it('hover: silent when blocked, shows the answer at the anchor, drops stale answers, closes with the menu', async () => {
    const anchor = { left: 10, top: 20, bottom: 36 };
    useStore.setState({ snapshot: snap(1, 'working', ['a.py']), lsp: LSP_OFF, toast: null });
    await useStore.getState().requestHover(target, anchor);
    expect(api.lspHover).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toBeNull();
    ready();
    await useStore.getState().requestHover({ ...target, side: 'old' }, anchor);
    expect(api.lspHover).not.toHaveBeenCalled();
    api.lspHover.mockResolvedValue({ contents: null });
    await useStore.getState().requestHover(target, anchor);
    expect(useStore.getState().hover).toBeNull();
    api.lspHover.mockResolvedValue({ contents: '```python\nfoo: int\n```' });
    await useStore.getState().requestHover(target, anchor);
    expect(useStore.getState().hover).toEqual({ target, contents: '```python\nfoo: int\n```', anchor });
    // A newer request or a close drops an older answer when it arrives.
    useStore.getState().closeHover();
    expect(useStore.getState().hover).toBeNull();
    const slow = deferred<{ contents: string | null }>();
    api.lspHover.mockReturnValueOnce(slow.promise);
    const first = useStore.getState().requestHover(target, anchor);
    await Promise.resolve(); // Let the syntax gate finish before replacing the LSP response.
    api.lspHover.mockResolvedValue({ contents: 'second' });
    await useStore.getState().requestHover({ ...target, col: 9 }, anchor);
    slow.resolve({ contents: 'first' });
    await first;
    expect(useStore.getState().hover?.contents).toBe('second');
    await useStore.getState().openSymbolMenu(target, 0, 0);
    expect(useStore.getState().hover).toBeNull();
    await useStore.getState().requestHover(target, anchor);
    expect(useStore.getState().hover).toBeNull();
  });

  it('uses the language server when syntax classification is unavailable', async () => {
    ready();
    useStore.setState({ toast: null, symbolMenu: null });
    const anchor = { left: 10, top: 20, bottom: 36 };
    const comment = { ...target, line: 2, col: 3, text: 'comment' };
    api.lspHover.mockResolvedValueOnce({ contents: 'foo: int' });
    await useStore.getState().requestHover(target, anchor);
    expect(useStore.getState().hover).not.toBeNull();

    api.lspHover.mockResolvedValueOnce({ contents: null });
    await useStore.getState().requestHover(comment, anchor);
    expect(api.lspHover).toHaveBeenLastCalledWith({ path: comment.path, line: comment.line, col: comment.col });
    expect(useStore.getState().hover).toBeNull();
    expect(useStore.getState().toast).toBeNull();

    // Some servers resolve documentation references inside comments.
    api.lspHover.mockResolvedValueOnce({ contents: 'Referenced symbol' });
    await useStore.getState().requestHover(comment, anchor);
    expect(useStore.getState().hover).toEqual({ target: comment, contents: 'Referenced symbol', anchor });
  });

  it('suppresses hover and menus on syntax-classified prose, including the old side', async () => {
    ready();
    useStore.setState({ symbolMenu: null, hover: null });
    blocksSymbol.mockResolvedValue(true);
    await useStore.getState().requestHover(target, { left: 0, top: 0, bottom: 0 });
    expect(api.lspHover).not.toHaveBeenCalled();
    expect(useStore.getState().hover).toBeNull();
    await useStore.getState().openSymbolMenu(target, 0, 0);
    await useStore.getState().openSymbolMenu({ ...target, side: 'old' }, 0, 0);
    expect(api.lspTokenKind).not.toHaveBeenCalled();
    expect(useStore.getState().symbolMenu).toBeNull();
  });

  it('drops syntax answers after closing a popup or starting a newer request', async () => {
    ready();
    useStore.setState({ symbolMenu: null, hover: null });
    const slow = deferred<boolean>();
    blocksSymbol.mockReturnValueOnce(slow.promise);
    const hover = useStore.getState().requestHover(target, { left: 0, top: 0, bottom: 0 });
    useStore.getState().closeHover();
    slow.resolve(false);
    await hover;
    expect(api.lspHover).not.toHaveBeenCalled();

    const oldClick = deferred<boolean>();
    blocksSymbol.mockReturnValueOnce(oldClick.promise);
    const menu = useStore.getState().openSymbolMenu(target, 1, 1);
    blocksSymbol.mockResolvedValue(true);
    await useStore.getState().openSymbolMenu({ ...target, col: 9 }, 2, 2);
    oldClick.resolve(false);
    await menu;
    expect(useStore.getState().symbolMenu).toBeNull();
    expect(api.lspTokenKind).not.toHaveBeenCalled();
  });

  it('drops syntax answers across a mode switch', async () => {
    ready();
    useStore.setState({ symbolMenu: null, hover: null });
    const slow = deferred<boolean>();
    blocksSymbol.mockReturnValue(slow.promise);
    const hover = useStore.getState().requestHover(target, { left: 0, top: 0, bottom: 0 });
    const menu = useStore.getState().openSymbolMenu(target, 1, 2);
    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().switchMode({ kind: 'pr' });
    slow.resolve(false);
    await Promise.all([hover, menu]);
    expect(api.lspHover).not.toHaveBeenCalled();
    expect(api.lspTokenKind).not.toHaveBeenCalled();
    expect(useStore.getState().symbolMenu).toBeNull();
    expect(useStore.getState().hover).toBeNull();
  });

  it('gh: opens the tooltip at the focused word, flashes when nothing is focused or known', async () => {
    ready();
    useStore.setState({ toast: null, symbolMenu: null });
    lspTarget.focus(null);
    await useStore.getState().showHover();
    expect(api.lspHover).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toMatch(/Hover a symbol first/);
    // Node environment: only the rect matters to the store.
    const el = { getBoundingClientRect: () => ({ left: 5, top: 7, bottom: 21 }) } as unknown as HTMLElement;
    lspTarget.focus(target, el);
    api.lspHover.mockResolvedValue({ contents: null });
    await useStore.getState().showHover();
    expect(useStore.getState().hover).toBeNull();
    expect(useStore.getState().toast).toMatch(/No hover information for foo/);
    api.lspHover.mockResolvedValue({ contents: 'foo: int' });
    await useStore.getState().showHover();
    expect(useStore.getState().hover).toEqual({
      target,
      contents: 'foo: int',
      anchor: { left: 5, top: 7, bottom: 21 },
    });
    // With the symbol menu open, gh closes it and shows the tooltip for its target.
    await useStore.getState().openSymbolMenu({ ...target, col: 9 }, 0, 0);
    await useStore.getState().showHover();
    expect(useStore.getState().symbolMenu).toBeNull();
    expect(useStore.getState().hover?.target.col).toBe(9);
    useStore.getState().closeHover();
    // The tooltip's own keydown listener closes hovers; running after the keymap in the same dispatch
    // it must not drop the answer gh asked for.
    const shown = useStore.getState().showHover();
    useStore.getState().closeHover();
    await shown;
    expect(useStore.getState().hover?.contents).toBe('foo: int');
    useStore.getState().closeHover();
    lspTarget.focus(null);
  });

  it('the symbol menu asks the server what the token is and stays shut on a keyword', async () => {
    ready();
    useStore.setState({ symbolMenu: null });
    api.lspTokenKind.mockResolvedValue({ kind: 'keyword' });
    await useStore.getState().openSymbolMenu({ ...target, text: 'if' }, 1, 2);
    expect(api.lspTokenKind).toHaveBeenCalledWith({ path: 'a.py', line: 3, col: 4 });
    expect(useStore.getState().symbolMenu).toBeNull();
    api.lspTokenKind.mockResolvedValue({ kind: 'variable' });
    await useStore.getState().openSymbolMenu(target, 1, 2);
    expect(useStore.getState().symbolMenu).toEqual({ target, x: 1, y: 2 });
    // A server without semantic tokens, or an outage, has no opinion: the menu opens as before.
    useStore.getState().closeSymbolMenu();
    api.lspTokenKind.mockRejectedValue(new Error('409'));
    await useStore.getState().openSymbolMenu(target, 1, 2);
    expect(useStore.getState().symbolMenu).not.toBeNull();
    // A close while the answer is in flight wins over the late answer.
    useStore.getState().closeSymbolMenu();
    const slow = deferred<{ kind: string | null }>();
    api.lspTokenKind.mockReturnValue(slow.promise);
    const opening = useStore.getState().openSymbolMenu(target, 1, 2);
    await Promise.resolve(); // Reach the semantic-token request after the syntax gate.
    useStore.getState().closeSymbolMenu();
    slow.resolve({ kind: 'variable' });
    await opening;
    expect(useStore.getState().symbolMenu).toBeNull();
    // Started with --no-lsp: nothing the menu offers can work, so there is no menu.
    api.lspTokenKind.mockClear();
    useStore.setState({ lsp: LSP_OFF });
    await useStore.getState().openSymbolMenu(target, 1, 2);
    expect(api.lspTokenKind).not.toHaveBeenCalled();
    expect(useStore.getState().symbolMenu).toBeNull();
    // A server that is starting or broken still gets a menu, whose actions explain the blocker.
    useStore.setState({ lsp: lspStatus('unavailable', { message: 'boom' }) });
    await useStore.getState().openSymbolMenu(target, 1, 2);
    expect(api.lspTokenKind).not.toHaveBeenCalled();
    expect(useStore.getState().symbolMenu).not.toBeNull();
  });

  it('an external definition opens the file read-only and keeps it open across a refresh', async () => {
    ready();
    const site = '/usr/lib/python3/os.py';
    api.file.mockResolvedValue({ path: site, contents: 'import sys\nsep = "/"\n', binary: false });
    api.lspDefinition.mockResolvedValue({
      locations: [{ path: site, line: 2, col: 0, text: 'sep = "/"', external: true }],
    });
    await useStore.getState().goToDefinition(target);
    let s = useStore.getState();
    expect(api.file).toHaveBeenCalledWith(site, 'new', expect.anything());
    expect(s.fileView).toMatchObject({ path: site, external: true, item: { kind: 'file' } });
    expect(s.activePath).toBe(site);
    expect(s.selection?.range.end).toBe(2);
    // No comments on it, and no navigation from it: the server knows only snapshot files.
    await useStore.getState().openDraft(s.selection!);
    expect(useStore.getState().draft).toBeNull();
    expect(useStore.getState().toast).toMatch(/repository files only/);
    api.lspDefinition.mockClear();
    await useStore.getState().goToDefinition({ ...target, path: site });
    expect(api.lspDefinition).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toMatch(/starts from a repository file/);
    useStore.setState({ toast: null });
    await useStore.getState().openSymbols('document');
    expect(api.lspSymbols).not.toHaveBeenCalled();
    expect(useStore.getState().symbols.open).toBe(false);
    expect(useStore.getState().toast).toMatch(/starts from a repository file/);
    // Jumps inside the view (G, 123gg) reopen the same path; that must not read as the file vanishing.
    useStore.setState({ toast: null });
    await useStore.getState().goToLine(1);
    expect(useStore.getState().toast).toBeNull();
    expect(useStore.getState().fileView).toMatchObject({ path: site, external: true });
    expect(useStore.getState().selection?.range.end).toBe(1);
    // The tree never lists it; a refresh must not mistake that for the file vanishing.
    api.snapshot.mockResolvedValueOnce(snap(2, 'working', ['a.py', 'b.py']));
    await useStore.getState().refreshSnapshot();
    s = useStore.getState();
    expect(s.fileView?.path).toBe(site);
    expect(api.file).toHaveBeenCalledTimes(1);
    // Ctrl+o leaves it; the jumplist entry it leaves behind re-enters the external file instead of a tree lookup.
    useStore.getState().jumpBack();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().fileView).toBeNull();
    useStore.getState().jumpBack();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().fileView).toMatchObject({ path: site, external: true });
  });

  it('go to definition opens the target file and records the jump', async () => {
    ready();
    api.lspDefinition.mockResolvedValue({
      locations: [{ path: 'b.py', line: 2, col: 0, text: 'y = 2' }],
    });
    await useStore.getState().goToDefinition(target);
    expect(api.lspDefinition).toHaveBeenCalledWith({ path: 'a.py', line: 3, col: 4 });
    const s = useStore.getState();
    expect(s.fileView?.path).toBe('b.py');
    expect(s.activePath).toBe('b.py');
    expect(s.selection?.range.end).toBe(2);
  });

  it('a hover link lands like gd and closes the tooltip', async () => {
    ready();
    api.lspHover.mockResolvedValue({ contents: 'Go to [f](diffle:b.py#L2)' });
    await useStore.getState().requestHover(target, { left: 0, top: 0, bottom: 0 });
    await useStore.getState().goToLink('b.py', 2);
    const s = useStore.getState();
    expect(s.hover).toBeNull();
    expect(s.fileView?.path).toBe('b.py');
    expect(s.activePath).toBe('b.py');
    expect(s.selection?.range.end).toBe(2);
  });

  it('go to type definition asks the type-definition endpoint and jumps the same way', async () => {
    ready();
    api.lspTypeDefinition.mockResolvedValue({
      locations: [{ path: 'b.py', line: 1, col: 0, text: 'class T' }],
    });
    await useStore.getState().goToTypeDefinition(target);
    expect(api.lspTypeDefinition).toHaveBeenCalledWith({ path: 'a.py', line: 3, col: 4 });
    expect(api.lspDefinition).not.toHaveBeenCalled();
    expect(useStore.getState().activePath).toBe('b.py');
    expect(useStore.getState().selection?.range.end).toBe(1);
    api.lspTypeDefinition.mockResolvedValue({ locations: [] });
    await useStore.getState().goToTypeDefinition(target);
    expect(useStore.getState().toast).toMatch(/No type definition found for foo/);
  });

  it('go to type definition with several answers offers them instead of jumping to the first', async () => {
    ready();
    const before = useStore.getState().selection;
    api.lspTypeDefinition.mockResolvedValue({
      locations: [
        { path: 'b.py', line: 1, col: 0, text: 'class Param' },
        { path: 'b.py', line: 2, col: 0, text: 'class Ret' },
      ],
    });
    await useStore.getState().goToTypeDefinition(target);
    const s = useStore.getState();
    expect(s.selection).toBe(before);
    expect(s.references).toMatchObject({ open: true, kind: 'types', symbol: 'foo', index: 0 });
    expect(s.references.items.map((m) => m.text)).toEqual(['class Param', 'class Ret']);
    // Picking one jumps there without turning the list into a search.
    s.moveReference(1);
    useStore.getState().pickReference();
    await vi.waitFor(() => expect(useStore.getState().selection?.range.end).toBe(2));
    expect(useStore.getState().search.open).toBe(false);
  });

  it('references open the overlay; picking one jumps and hands the list to n / N', async () => {
    ready();
    api.lspReferences.mockResolvedValue({
      locations: [
        { path: 'b.py', line: 1, col: 0, text: 'x = 1' },
        { path: 'b.py', line: 2, col: 0, text: 'y = 2' },
      ],
    });
    await useStore.getState().findReferences(target);
    let s = useStore.getState();
    expect(s.references.open).toBe(true);
    expect(s.references.symbol).toBe('foo');
    expect(s.references.items).toHaveLength(2);
    expect(s.references.index).toBe(0);
    s.moveReference(1);
    expect(useStore.getState().references.index).toBe(1);
    useStore.getState().pickReference();
    s = useStore.getState();
    expect(s.references.open).toBe(false);
    expect(s.search.kind).toBe('references');
    expect(s.search.matches).toHaveLength(2);
    expect(s.search.index).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().activePath).toBe('b.py');
    useStore.getState().moveMatch(1);
    expect(useStore.getState().search.index).toBe(0);
    useStore.getState().closeSearch();
    expect(useStore.getState().search.kind).toBe('text');
  });

  it('* / # search the focused word whole-word from the cursor, and n keeps their direction', async () => {
    ready();
    useStore.setState({
      fileView: {
        path: 'a.py',
        external: false,
        item: { kind: 'file', file: { name: 'a.py', contents: 'foo\nbar\nfoo\nfoo\n', cacheKey: 'a' } },
        from: { position: null, activePath: null },
      },
    });
    const id = itemIdOf(useStore.getState(), 'a.py');
    useStore.setState({ selection: { id, range: { start: 3, side: 'additions', end: 3, endSide: 'additions' } } });
    lspTarget.focus(target);
    const matches = [
      { path: 'a.py', line: 1, text: 'foo' },
      { path: 'a.py', line: 3, text: 'foo' },
      { path: 'a.py', line: 4, text: 'foo' },
      { path: 'b.py', line: 2, text: 'foo' },
    ];
    api.search.mockResolvedValue({ query: 'foo', matches, truncated: false });

    await useStore.getState().searchWord(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.search).toHaveBeenCalledWith('foo', { word: true, scope: 'repo' });
    let s = useStore.getState();
    expect(s.search.kind).toBe('word');
    expect(s.search.direction).toBe(1);
    expect(s.search.index).toBe(2);
    expect(s.selection?.range.end).toBe(4);

    useStore.setState({ selection: { id, range: { start: 3, side: 'additions', end: 3, endSide: 'additions' } } });
    await useStore.getState().searchWord(-1);
    await new Promise((r) => setTimeout(r, 0));
    s = useStore.getState();
    expect(s.search.direction).toBe(-1);
    expect(s.search.index).toBe(0);
    s.moveMatch(1); // n after # keeps going upwards, wrapping to the last match
    expect(useStore.getState().search.index).toBe(3);
    useStore.getState().moveMatch(-1);
    expect(useStore.getState().search.index).toBe(0);
    lspTarget.focus(null);
    useStore.getState().closeSearch();
  });

  it('/ searches only the file the reader is in; g/ widens to the diff without forgetting a repo choice', async () => {
    ready();
    useStore.setState({ activePath: 'b.py' });
    api.search.mockResolvedValue({ query: 'x', matches: [{ path: 'b.py', line: 2, text: 'y = 2' }], truncated: false });

    useStore.getState().openSearch('file');
    expect(useStore.getState().search.scope).toBe('file');
    await useStore.getState().runSearch('y');
    await new Promise((r) => setTimeout(r, 0));
    expect(api.search).toHaveBeenCalledWith('y', { ignoreCase: true, regex: false, scope: 'file', path: 'b.py' });
    let s = useStore.getState();
    expect(s.search.path).toBe('b.py');
    expect(s.search.index).toBe(0);
    expect(s.selection?.range.end).toBe(2);

    // The remembered scope: a file search leaves the codebase choice for g/ to return to.
    useStore.getState().setSearchOptions({ scope: 'repo' });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.search).toHaveBeenLastCalledWith('y', { ignoreCase: true, regex: false, scope: 'repo' });
    expect(useStore.getState().search.path).toBeNull();
    useStore.getState().openSearch('file');
    useStore.getState().openSearch();
    expect(useStore.getState().search.scope).toBe('file');
    useStore.getState().closeSearch();
    useStore.setState((s) => ({ search: { ...s.search, scope: 'diff' } })); // the scope outlives the bar; later tests expect the default
  });

  it('a file search with no file to pin to says so instead of querying', async () => {
    useStore.setState({ snapshot: snap(1, 'working', []), activePath: null, fileView: null });
    useStore.getState().openSearch('file');
    await useStore.getState().runSearch('y');
    expect(api.search).not.toHaveBeenCalled();
    const s = useStore.getState();
    expect(s.toast).toBe('No file to search in');
    expect(s.search.loading).toBe(false);
    useStore.getState().closeSearch();
    useStore.setState((s) => ({ search: { ...s.search, scope: 'diff' } }));
  });

  it('workspace symbol queries are debounced: a burst of keystrokes is one request for the last query', async () => {
    vi.useFakeTimers();
    try {
      const sym = { name: 'foo', kind: 12, path: 'a.py', line: 1, endLine: 1, col: 0 };
      api.lspSymbols.mockResolvedValue([sym]);
      useStore.setState({
        symbols: {
          open: true,
          scope: 'workspace',
          path: null,
          query: '',
          all: [],
          items: [],
          index: -1,
          loading: false,
        },
      });
      const first = useStore.getState().querySymbols('f');
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYMBOL_DEBOUNCE_MS / 2);
      const second = useStore.getState().querySymbols('fo');
      expect(useStore.getState().symbols).toMatchObject({ query: 'fo', loading: true });
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYMBOL_DEBOUNCE_MS / 2);
      expect(api.lspSymbols).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYMBOL_DEBOUNCE_MS / 2);
      await Promise.all([first, second]);
      expect(api.lspSymbols).toHaveBeenCalledTimes(1);
      expect(api.lspSymbols).toHaveBeenCalledWith({ q: 'fo' });
      expect(useStore.getState().symbols).toMatchObject({ items: [sym], index: 0, loading: false });
      // Clearing the query cancels the pending fetch outright.
      void useStore.getState().querySymbols('x');
      void useStore.getState().querySymbols('');
      await vi.advanceTimersByTimeAsync(WORKSPACE_SYMBOL_DEBOUNCE_MS * 2);
      expect(api.lspSymbols).toHaveBeenCalledTimes(1);
      expect(useStore.getState().symbols).toMatchObject({ items: [], loading: false });
      useStore.getState().closeSymbols();
    } finally {
      vi.useRealTimers();
    }
  });

  it('document symbols filter by prefix, substring, then subsequence', () => {
    const sym = (name: string) => ({ name, kind: 12, path: 'a.py', line: 1, endLine: 1, col: 0 });
    const all = [sym('parse_args'), sym('argparse'), sym('apply'), sym('zzz')];
    expect(filterSymbols(all, 'arg').map((s) => s.name)).toEqual(['argparse', 'parse_args']);
    expect(filterSymbols(all, 'ply').map((s) => s.name)).toEqual(['apply']);
    expect(filterSymbols(all, 'pags').map((s) => s.name)).toEqual(['parse_args']);
    expect(filterSymbols(all, '').map((s) => s.name)).toHaveLength(4);
  });
});

const file = (over: Partial<ChangedFile>): ChangedFile => ({
  path: 'a.py',
  status: 'M',
  additions: 3,
  deletions: 1,
  binary: false,
  blob: 'b2',
  generated: false,
  ...over,
});
const thread = (
  over: Partial<Omit<CommentThread, 'anchor'>> & { anchor?: Partial<CommentThread['anchor']> },
): CommentThread => ({
  id: over.id ?? 't',
  anchor: { path: 'a.py', side: 'new', startLine: 1, endLine: 1, quoted: 'x', ...over.anchor },
  messages: [{ id: 'm', body: 'b', createdAt: 1, updatedAt: 1 }],
  resolved: over.resolved ?? false,
  stale: false,
});
const config = { autoViewed: ['*.lock'], contextLines: 5, lspCommands: {} };

describe('request ownership', () => {
  type SearchResponse = { query: string; matches: { path: string; line: number; text: string }[]; truncated: boolean };
  const hit = (path: string, line: number): SearchResponse => ({
    query: 'q',
    matches: [{ path, line, text: 'q' }],
    truncated: false,
  });
  const ready = () => {
    useStore.setState({ snapshot: snap(1, 'working', ['a.py', 'b.py']), lsp: lspStatus('ready') });
    api.file.mockResolvedValue({ path: 'b.py', contents: 'x = 1\ny = 2\n', binary: false });
  };

  it('a search that completes after Escape neither shows matches nor moves the cursor', async () => {
    ready();
    const slow = deferred<SearchResponse>();
    api.search.mockReturnValueOnce(slow.promise);
    const run = useStore.getState().runSearch('foo');
    expect(useStore.getState().search.loading).toBe(true);
    useStore.getState().closeSearch();
    slow.resolve(hit('b.py', 2));
    await run;
    await new Promise((r) => setTimeout(r, 0));
    const s = useStore.getState();
    expect(s.search.matches).toEqual([]);
    expect(s.search.loading).toBe(false);
    expect(s.selection).toBeNull();
    expect(s.fileView).toBeNull();
  });

  it("two searches completing backwards keep the newer query's matches", async () => {
    ready();
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    api.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = useStore.getState().runSearch('foo');
    const b = useStore.getState().runSearch('bar');
    second.resolve(hit('b.py', 2));
    await b;
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().selection?.range.end).toBe(2);
    first.resolve(hit('b.py', 1));
    await a;
    await new Promise((r) => setTimeout(r, 0));
    const s = useStore.getState();
    expect(s.search.query).toBe('bar');
    expect(s.search.matches).toEqual(hit('b.py', 2).matches);
    expect(s.search.loading).toBe(false);
    expect(s.selection?.range.end).toBe(2);
  });

  it('a word search completing after a mode switch is dropped', async () => {
    ready();
    lspTarget.focus({ path: 'a.py', side: 'new', line: 3, col: 4, text: 'foo' });
    const slow = deferred<SearchResponse>();
    api.search.mockReturnValueOnce(slow.promise);
    const run = useStore.getState().searchWord(1);
    lspTarget.focus(null);
    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['b.py']));
    await useStore.getState().switchMode({ kind: 'pr' });
    slow.resolve(hit('b.py', 2));
    await run;
    await new Promise((r) => setTimeout(r, 0));
    const s = useStore.getState();
    expect(s.search.open).toBe(false);
    expect(s.search.matches).toEqual([]);
    expect(s.search.loading).toBe(false);
    expect(s.selection).toBeNull();
  });

  it('a definition that arrives after a mode switch does not jump', async () => {
    ready();
    const slow = deferred<{
      locations: { path: string; line: number; col: number; text: string }[];
    }>();
    api.lspDefinition.mockReturnValueOnce(slow.promise);
    const go = useStore.getState().goToDefinition({ path: 'a.py', side: 'new', line: 3, col: 4, text: 'foo' });
    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['b.py']));
    await useStore.getState().switchMode({ kind: 'pr' });
    slow.resolve({ locations: [{ path: 'b.py', line: 2, col: 0, text: 'y = 2' }] });
    await go;
    await new Promise((r) => setTimeout(r, 0));
    const s = useStore.getState();
    expect(s.fileView).toBeNull();
    expect(s.selection).toBeNull();
    expect(api.file).not.toHaveBeenCalled();
  });

  it('references that arrive after a mode switch stay closed', async () => {
    ready();
    const slow = deferred<{ locations: { path: string; line: number; col: number; text: string }[] }>();
    api.lspReferences.mockReturnValueOnce(slow.promise);
    const find = useStore.getState().findReferences({ path: 'a.py', side: 'new', line: 3, col: 4, text: 'foo' });
    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['b.py']));
    await useStore.getState().switchMode({ kind: 'pr' });
    slow.resolve({ locations: [{ path: 'b.py', line: 2, col: 0, text: 'foo' }] });
    await find;
    expect(useStore.getState().references.open).toBe(false);
  });

  it("a viewed mutation completing after a mode switch does not replace the new mode's marks", async () => {
    const changed = [file({ path: 'a.py', blob: 'b1' })];
    useStore.setState({ snapshot: { ...snap(1, 'working', ['a.py']), changed } });
    const slow = deferred<ViewedEntry[]>();
    api.setViewed.mockReturnValueOnce(slow.promise);
    const mark = useStore.getState().setViewed('a.py', true);
    expect(useStore.getState().viewed).toEqual([{ path: 'a.py', blob: 'b1', viewed: true }]);
    api.viewed.mockResolvedValueOnce([{ path: 'c.py', blob: 'c1', viewed: true }]);
    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.py']));
    await useStore.getState().switchMode({ kind: 'pr' });
    slow.resolve([{ path: 'a.py', blob: 'b1', viewed: true }]);
    await mark;
    expect(useStore.getState().viewed).toEqual([{ path: 'c.py', blob: 'c1', viewed: true }]);
  });

  it('a viewed file that changes afterwards reopens as restale; untouched folds survive the refresh', async () => {
    const changed = [file({ path: 'a.py', blob: 'b1' }), file({ path: 'b.py', blob: 'c1' })];
    useStore.setState({ snapshot: { ...snap(1, 'working', ['a.py', 'b.py']), changed } });
    api.setViewed.mockResolvedValueOnce([{ path: 'a.py', blob: 'b1', viewed: true }]);
    api.patches.mockResolvedValue(patchesFor(['a.py', 'b.py']));
    await useStore.getState().setViewed('a.py', true);
    useStore.setState((s) => ({ collapsed: { ...s.collapsed, 'b.py': true } }));
    expect(isCollapsed(useStore.getState(), 'a.py')).toBe(true);
    api.viewed.mockResolvedValueOnce([{ path: 'a.py', blob: 'b1', viewed: true }]);
    api.snapshot.mockResolvedValueOnce({
      ...snap(2, 'working', ['a.py', 'b.py']),
      changed: [file({ path: 'a.py', blob: 'b2' }), file({ path: 'b.py', blob: 'c1' })],
    });
    await useStore.getState().refreshSnapshot();
    const s = useStore.getState();
    expect(viewedState(s, file({ path: 'a.py', blob: 'b2' }))).toBe('restale');
    expect(isCollapsed(s, 'a.py')).toBe(false);
    expect(isCollapsed(s, 'b.py')).toBe(true);
  });

  it('a failed viewed mutation from a previous mode neither toasts nor refetches', async () => {
    const changed = [file({ path: 'a.py', blob: 'b1' })];
    useStore.setState({ snapshot: { ...snap(1, 'working', ['a.py']), changed }, toast: null });
    const slow = deferred<ViewedEntry[]>();
    api.setViewed.mockReturnValueOnce(slow.promise);
    const mark = useStore.getState().setViewed('a.py', true);
    api.switchMode.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.py']));
    await useStore.getState().switchMode({ kind: 'pr' });
    const viewedCalls = api.viewed.mock.calls.length;
    slow.reject(new Error('boom'));
    await mark;
    expect(useStore.getState().toast).toBeNull();
    expect(api.viewed).toHaveBeenCalledTimes(viewedCalls);
  });

  it('viewed writes run in order and the newest response wins', async () => {
    const changed = [file({ path: 'a.py', blob: 'b1' }), file({ path: 'b.py', blob: 'b2' })];
    useStore.setState({ snapshot: { ...snap(1, 'working', ['a.py', 'b.py']), changed } });
    const first = deferred<ViewedEntry[]>();
    const second = deferred<ViewedEntry[]>();
    api.setViewed.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = useStore.getState().setViewed('a.py', true);
    const b = useStore.getState().setViewed('b.py', true);
    // The second write waits for the first to answer.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.setViewed).toHaveBeenCalledTimes(1);
    first.resolve([{ path: 'a.py', blob: 'b1', viewed: true }]);
    await a;
    expect(api.setViewed).toHaveBeenCalledTimes(2);
    second.resolve([
      { path: 'a.py', blob: 'b1', viewed: true },
      { path: 'b.py', blob: 'b2', viewed: true },
    ]);
    await b;
    expect(useStore.getState().viewed).toHaveLength(2);
  });

  it('two thread refreshes of one transition commit in request order', async () => {
    useStore.setState({ snapshot: snap(1, 'working') });
    const first = deferred<CommentThread[]>();
    const second = deferred<CommentThread[]>();
    api.threads.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = useStore.getState().refreshThreads();
    const b = useStore.getState().refreshThreads();
    second.resolve([thread({ id: 'newer' })]);
    await b;
    first.resolve([thread({ id: 'older' })]);
    await a;
    expect(useStore.getState().threads.map((t) => t.id)).toEqual(['newer']);
  });

  it('two viewed refreshes of one transition commit in request order', async () => {
    useStore.setState({ snapshot: snap(1, 'working') });
    const first = deferred<ViewedEntry[]>();
    const second = deferred<ViewedEntry[]>();
    api.viewed.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = useStore.getState().refreshViewed();
    const b = useStore.getState().refreshViewed();
    second.resolve([{ path: 'a.py', blob: 'b2', viewed: true }]);
    await b;
    first.resolve([{ path: 'a.py', blob: 'b1', viewed: true }]);
    await a;
    expect(useStore.getState().viewed).toEqual([{ path: 'a.py', blob: 'b2', viewed: true }]);
  });

  it("a snapshot refresh's lists lose to a list refresh that started later", async () => {
    useStore.setState({ snapshot: snap(1, 'working') });
    const early = deferred<CommentThread[]>();
    const late = deferred<CommentThread[]>();
    api.threads.mockReturnValueOnce(early.promise).mockReturnValueOnce(late.promise);
    api.snapshot.mockResolvedValueOnce(snap(2, 'working'));
    const refresh = useStore.getState().refreshSnapshot();
    const pushed = useStore.getState().refreshThreads();
    late.resolve([thread({ id: 'newer' })]);
    await pushed;
    early.resolve([thread({ id: 'older' })]);
    await refresh;
    expect(useStore.getState().snapshot?.version).toBe(2);
    expect(useStore.getState().threads.map((t) => t.id)).toEqual(['newer']);
  });

  it('config loads and saves: the newest request wins and saves run in order', async () => {
    const cfg = (contextLines: number): UserConfig => ({ autoViewed: [], contextLines, lspCommands: {} });
    const load = deferred<UserConfig>();
    const save = deferred<UserConfig>();
    api.config.mockReturnValueOnce(load.promise);
    api.saveConfig.mockReturnValueOnce(save.promise);
    const loading = useStore.getState().refreshConfig();
    const saving = useStore.getState().saveConfig(cfg(9));
    save.resolve(cfg(9));
    await saving;
    expect(useStore.getState().config.contextLines).toBe(9);
    load.resolve(cfg(3));
    await loading;
    expect(useStore.getState().config.contextLines).toBe(9);

    const first = deferred<UserConfig>();
    const second = deferred<UserConfig>();
    api.saveConfig.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = useStore.getState().saveConfig(cfg(1));
    const b = useStore.getState().saveConfig(cfg(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.saveConfig).toHaveBeenCalledTimes(2);
    first.resolve(cfg(1));
    await a;
    expect(api.saveConfig).toHaveBeenCalledTimes(3);
    second.resolve(cfg(2));
    await b;
    expect(useStore.getState().config.contextLines).toBe(2);
  });
});

describe('viewedState', () => {
  it('derives restale from a viewed mark at an older blob and lets the current blob win', () => {
    const f = file({});
    expect(viewedState({ viewed: [], config }, f)).toBe('unviewed');
    expect(viewedState({ viewed: [{ path: 'a.py', blob: 'b1', viewed: true }], config }, f)).toBe('restale');
    expect(viewedState({ viewed: [{ path: 'a.py', blob: 'b1', viewed: false }], config }, f)).toBe('unviewed');
    expect(
      viewedState(
        {
          viewed: [
            { path: 'a.py', blob: 'b1', viewed: true },
            { path: 'a.py', blob: 'b2', viewed: false },
          ],
          config,
        },
        f,
      ),
    ).toBe('unviewed');
    expect(
      viewedState(
        {
          viewed: [
            { path: 'a.py', blob: 'b1', viewed: true },
            { path: 'a.py', blob: 'b2', viewed: true },
          ],
          config,
        },
        f,
      ),
    ).toBe('viewed');
    expect(viewedState({ viewed: [], config }, file({ path: 'x.lock' }))).toBe('viewed');
  });

  it('collapses generated files by default and a restale file stays open', () => {
    const s = { ...snap(1, 'working'), changed: [file({ path: 'gen.py', generated: true }), file({})] };
    expect(isCollapsed({ collapsed: {}, viewed: [], config, snapshot: s }, 'gen.py')).toBe(true);
    expect(
      isCollapsed({ collapsed: {}, viewed: [{ path: 'a.py', blob: 'b1', viewed: true }], config, snapshot: s }, 'a.py'),
    ).toBe(false);
    expect(isCollapsed({ collapsed: { 'gen.py': false }, viewed: [], config, snapshot: s }, 'gen.py')).toBe(false);
  });
});

describe('threads', () => {
  it('hides resolved threads until asked and resolves the thread under the cursor', async () => {
    useStore.setState({
      snapshot: snap(1, 'working', ['a.py']),
      threads: [thread({ id: 'open' }), thread({ id: 'done', resolved: true, anchor: { startLine: 5, endLine: 5 } })],
      selection: { id: 'diff:a.py@0', range: { start: 1, side: 'additions', end: 1, endSide: 'additions' } },
    });
    api.setResolved.mockResolvedValue({});
    api.threads.mockResolvedValueOnce([
      thread({ id: 'open', resolved: true }),
      thread({ id: 'done', resolved: true, anchor: { startLine: 5, endLine: 5 } }),
    ]);
    await useStore.getState().toggleResolvedAtCursor();
    expect(api.setResolved).toHaveBeenCalledWith('open', true);
    expect(useStore.getState().threads.every((t) => t.resolved)).toBe(true);
    useStore.setState({
      selection: { id: 'diff:a.py@0', range: { start: 5, side: 'additions', end: 5, endSide: 'additions' } },
    });
    await useStore.getState().toggleResolvedAtCursor();
    // Resolved threads are invisible, so nothing sits under the cursor.
    expect(api.setResolved).toHaveBeenCalledTimes(1);
    useStore.getState().setShowResolved(true);
    await useStore.getState().toggleResolvedAtCursor();
    expect(api.setResolved).toHaveBeenLastCalledWith('done', false);
  });

  it("a reply on one file leaves the other files' threads and versions untouched", async () => {
    const a = thread({ id: 'a', anchor: { path: 'a.py' } });
    const b = thread({ id: 'b', anchor: { path: 'b.py' } });
    useStore.setState({ snapshot: snap(1, 'working', ['a.py', 'b.py']), threads: [a, b] });
    const version = (path: string, prev?: ReturnType<typeof itemVersion>) => {
      const s = useStore.getState();
      const mine = visibleThreads(s).filter((t) => t.anchor.path === path);
      return itemVersion(prev, itemDeps(s, path, mine, false));
    };
    const va = version('a.py');
    const vb = version('b.py');

    api.reply.mockResolvedValue({});
    const replied = { ...a, messages: [...a.messages, { id: 'm2', body: 'r', createdAt: 2, updatedAt: 2 }] };
    api.threads.mockResolvedValueOnce([replied, { ...b }]);
    await useStore.getState().submitReply('a', 'r');
    const s = useStore.getState();
    // The fetched copy of b is the same content, so the store keeps the object it had.
    expect(s.threads[1]).toBe(b);
    expect(s.threads[0]).not.toBe(a);
    expect(version('a.py', va).version).toBe(va.version + 1);
    expect(version('b.py', vb)).toBe(vb);
  });

  it('closing a draft by changing the diff style or clearing the selection re-renders its file', () => {
    useStore.setState({ snapshot: snap(1, 'working', ['a.py']), threads: [] });
    const version = (prev?: ReturnType<typeof itemVersion>) =>
      itemVersion(prev, itemDeps(useStore.getState(), 'a.py', [], false));
    const idle = version();
    const sel = {
      id: 'diff:a.py@0',
      range: { start: 2, side: 'additions' as const, end: 2, endSide: 'additions' as const },
    };
    void useStore.getState().openDraft(sel);
    const open = version(idle);
    expect(open.version).toBe(idle.version + 1);
    useStore.getState().setDiffStyle('unified');
    expect(useStore.getState().draft).toBeNull();
    expect(version(open).version).toBe(open.version + 1);

    void useStore.getState().openDraft(sel);
    const again = version(open);
    useStore.getState().setSelection(null);
    expect(useStore.getState().draft).toBeNull();
    expect(version(again).version).toBe(again.version + 1);
    useStore.getState().setDiffStyle('split');
  });

  it('opens one composer at a time: a reply closes the draft and vice versa', () => {
    useStore.setState({ snapshot: snap(1, 'working', ['a.py']), threads: [thread({ id: 't1' })] });
    void useStore
      .getState()
      .openDraft({ id: 'diff:a.py@0', range: { start: 2, side: 'additions', end: 2, endSide: 'additions' } });
    expect(useStore.getState().draft?.path).toBe('a.py');
    useStore.getState().openReply('t1');
    expect(useStore.getState().replyTo).toBe('t1');
    expect(useStore.getState().draft).toBeNull();
    void useStore
      .getState()
      .openDraft({ id: 'diff:a.py@0', range: { start: 2, side: 'additions', end: 2, endSide: 'additions' } });
    expect(useStore.getState().replyTo).toBeNull();
    useStore.getState().escape();
    expect(useStore.getState().draft).toBeNull();
  });
});

describe('scrollCursorTo', () => {
  it('zz pins the cursor line at eye level, the same alignment hunk jumps use, without moving the cursor or recording a jump', () => {
    useStore.setState({
      selection: { id: 'diff:a.py@1', range: { start: 3, side: 'additions', end: 5, endSide: 'additions' } },
      jumps: [],
      jumpIndex: 0,
      scrollTarget: null,
    });
    useStore.getState().scrollCursorTo('eye');
    const s = useStore.getState();
    expect(s.scrollTarget).toEqual({ id: 'diff:a.py@1', line: 5, side: 'new', align: 'eye', nonce: 1 });
    expect(s.selection?.range.end).toBe(5);
    expect(s.jumps).toEqual([]);
    useStore.getState().scrollCursorTo('top');
    expect(useStore.getState().scrollTarget).toEqual(expect.objectContaining({ align: 'top', nonce: 2 }));
  });
  it('without a cursor it explains instead of scrolling', () => {
    useStore.setState({ selection: null, scrollTarget: null });
    useStore.getState().scrollCursorTo('eye');
    expect(useStore.getState().scrollTarget).toBeNull();
    expect(useStore.getState().toast).toBe('No line under the cursor');
  });
  it('switching split / unified keeps the cursor and re-pins its line', () => {
    const selection = {
      id: 'diff:a.py@1',
      range: { start: 3, side: 'additions' as const, end: 3, endSide: 'additions' as const },
    };
    useStore.setState({ selection, scrollTarget: null, diffStyle: 'split' });
    useStore.getState().setDiffStyle('unified');
    const s = useStore.getState();
    expect(s.diffStyle).toBe('unified');
    expect(s.selection).toEqual(selection);
    expect(s.scrollTarget).toEqual(expect.objectContaining({ id: 'diff:a.py@1', line: 3, align: 'eye' }));
  });
});

describe('goToLine', () => {
  it('moves the cursor to that line of the active file and records the origin', async () => {
    const file = (path: string) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      blob: `b-${path}`,
      generated: false,
    });
    api.patch.mockImplementation(
      async (path: string) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n x\n-y\n+foo\n z\n`,
    );
    api.snapshot.mockResolvedValueOnce({
      ...snap(1, 'working', ['a.py', 'b.py']),
      changed: [file('a.py'), file('b.py')],
    });
    await useStore.getState().refreshSnapshot();
    useStore.setState({
      selection: {
        id: itemIdOf(useStore.getState(), 'b.py'),
        range: { start: 1, side: 'additions', end: 1, endSide: 'additions' },
      },
      activePath: 'b.py',
    });

    await useStore.getState().goToLine(3);
    await new Promise((r) => setTimeout(r, 0));
    const s = useStore.getState();
    expect(s.activePath).toBe('b.py');
    expect(s.selection).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^diff:b\.py@/),
        range: expect.objectContaining({ end: 3 }),
      }),
    );
    // No rows are rendered here, so the line is treated as folded context and revealed at eye level.
    expect(s.reveal).toEqual(expect.objectContaining({ path: 'b.py', line: 3 }));
    expect(s.jumps).toEqual([{ path: 'b.py', side: 'new', line: 1 }]);

    useStore.setState({ activePath: null, fileView: null, selection: null, toast: null, snapshot: null });
    await useStore.getState().goToLine(3);
    expect(useStore.getState().toast).toBe('No file to jump in');
    api.patch.mockReset();
  });
});

describe('jumplist', () => {
  it('a search jump records the origin once, so one Ctrl+o restores it', async () => {
    const file = (path: string) => ({
      path,
      status: 'M' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      blob: `b-${path}`,
      generated: false,
    });
    api.patch.mockImplementation(
      async (path: string) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n x\n-y\n+foo\n z\n`,
    );
    api.snapshot.mockResolvedValueOnce({
      ...snap(1, 'working', ['a.py', 'b.py']),
      changed: [file('a.py'), file('b.py')],
    });
    await useStore.getState().refreshSnapshot();
    useStore.setState({
      selection: {
        id: itemIdOf(useStore.getState(), 'a.py'),
        range: { start: 1, side: 'additions', end: 1, endSide: 'additions' },
      },
      activePath: 'a.py',
    });

    api.search.mockResolvedValue({ query: 'foo', matches: [{ path: 'b.py', line: 2, text: 'foo' }], truncated: false });
    await useStore.getState().runSearch('foo');
    await new Promise((r) => setTimeout(r, 0));
    let s = useStore.getState();
    expect(s.selection).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^diff:b\.py@/),
        range: expect.objectContaining({ end: 2 }),
      }),
    );
    // Only the origin is remembered: opening b.py parked the cursor on its first hunk on the way, and that is not a place the reader saw.
    expect(s.jumps).toEqual([{ path: 'a.py', side: 'new', line: 1 }]);
    expect(s.jumpIndex).toBe(1);

    useStore.getState().jumpBack();
    await new Promise((r) => setTimeout(r, 0));
    s = useStore.getState();
    expect(s.selection).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^diff:a\.py@/),
        range: expect.objectContaining({ end: 1 }),
      }),
    );
    expect(s.activePath).toBe('a.py');
    api.patch.mockReset();
  });
});

describe('asynchronous GitHub metadata', () => {
  it('renders the comparison and local repository while PR lookup is pending', async () => {
    const lookup = deferred<GithubMetadata>();
    api.github.mockReturnValueOnce(lookup.promise);
    api.snapshot.mockResolvedValueOnce(snap(1, 'first'));
    await useStore.getState().boot();
    expect(useStore.getState().snapshot?.version).toBe(1);
    expect(useStore.getState().github.status).toBe('loading');
    lookup.resolve({ version: 1, repository: 'o/r', pullRequest: null, reason: 'No PR' });
    await vi.waitFor(() => expect(useStore.getState().github.status).toBe('ready'));
  });

  it('discards a slow lookup after another comparison has loaded', async () => {
    const old = deferred<GithubMetadata>();
    api.github.mockReturnValueOnce(old.promise);
    api.snapshot.mockResolvedValueOnce(snap(1, 'first'));
    await useStore.getState().boot();
    api.switchMode.mockResolvedValueOnce(snap(2, 'second'));
    await useStore.getState().switchMode({ kind: 'revspec', args: ['main'] });
    await vi.waitFor(() => expect(useStore.getState().github.data?.version).toBe(2));
    old.resolve({ version: 1, repository: 'o/r', pullRequest: null, reason: null });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(useStore.getState().github.data).toMatchObject({ version: 2, reason: 'No matching pull request' });
  });
});

it('recovers GitHub lookup for the existing comparison after a failed switch', async () => {
  const pending = deferred<GithubMetadata>();
  api.github.mockReturnValueOnce(pending.promise);
  api.snapshot.mockResolvedValueOnce(snap(1, 'first'));
  await useStore.getState().boot();
  expect(useStore.getState().github.status).toBe('loading');
  api.switchMode.mockRejectedValueOnce(new Error('unknown revision'));
  await useStore.getState().switchMode({ kind: 'revspec', args: ['missing'] });
  await vi.waitFor(() => expect(useStore.getState().github.status).toBe('ready'));
  expect(useStore.getState().github.data?.version).toBe(1);
  pending.resolve({ version: 1, repository: 'o/r', pullRequest: null, reason: null });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(useStore.getState().github.data?.reason).toBe('No matching pull request');
});

it('discards metadata for a newer server snapshot without changing the displayed comparison', async () => {
  api.snapshot.mockResolvedValueOnce(snap(1, 'first'));
  api.github.mockResolvedValueOnce({ version: 2, repository: 'o/r', pullRequest: null, reason: null });
  await useStore.getState().boot();
  await vi.waitFor(() => expect(useStore.getState().github.status).toBe('idle'));
  expect(useStore.getState().snapshot?.version).toBe(1);
  expect(useStore.getState().github.data).toBeUndefined();
});
