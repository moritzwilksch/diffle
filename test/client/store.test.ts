import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubMetadata,
  ChangedFile,
  CommentThread,
  LspLogResponse,
  LspServerStatus,
  LspStatus,
  Moved,
  GraphResponse,
  Snapshot,
  UserConfig,
  ViewedEntry,
} from '@/shared/protocol.js';
import { IDLE_GRAPH } from '@/client/connected/clusters/focus.js';

/** One python server in `state`; LSP_OFF is a run started with --no-lsp. */
const lspStatus = (state: LspServerStatus['state'], extra: Partial<LspServerStatus> = {}): LspStatus => ({
  enabled: true,
  servers: [
    {
      name: 'pyrefly',
      command: 'pyrefly lsp',
      state,
      languages: ['python'],
      joins: [],
      supports: [
        'definition',
        'typeDefinition',
        'hover',
        'references',
        'documentSymbol',
        'workspaceSymbol',
        'documentHighlight',
      ],
      log: NO_LOG,
      ...extra,
    },
  ],
  missing: [],
});
const NO_LOG = { seq: 0, errors: 0, warnings: 0 };
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
    followRefs: 'off',
    lineWrap: true,
    lspCommands: { python: 'pyrefly lsp' },
    githubHosts: {},
  })),
  lspStatus: vi.fn(async (): Promise<LspStatus> => LSP_OFF),
  lspLog: vi.fn(async (): Promise<LspLogResponse> => ({ entries: [] })),
  moved: vi.fn(async (): Promise<Moved | null> => null),
  lspDefinition: vi.fn(),
  lspTypeDefinition: vi.fn(),
  lspReferences: vi.fn(),
  lspHover: vi.fn(),
  lspSymbols: vi.fn(),
  enter: vi.fn(),
  file: vi.fn(),
  graph: vi.fn(),
  reload: vi.fn(),
  patch: vi.fn(),
  patches: vi.fn(),
  setResolved: vi.fn(),
  reply: vi.fn(),
  addThread: vi.fn(),
  search: vi.fn(),
  setViewed: vi.fn(),
  setViewedBulk: vi.fn(),
  saveConfig: vi.fn(),
  exportToGithub: vi.fn(),
};
vi.mock('@/client/api.js', () => ({ api }));
const { blocksSymbol } = vi.hoisted(() => ({ blocksSymbol: vi.fn() }));
vi.mock('@/client/lsp/syntax.js', () => ({ blocksSymbol }));

const { useStore, TOAST_MS, WORKSPACE_SYMBOL_DEBOUNCE_MS } = await import('@/client/store.js');
const {
  viewedState,
  isCollapsed,
  itemIdOf,
  itemDeps,
  itemVersion,
  visibleThreads,
  listedPaths,
  reviewPaths,
  countViewed,
  OVERSIZED_LINES,
  PATCH_BATCH_LINES,
  PATCH_BATCH_FILES,
} = await import('@/client/model.js');
/** A one-line patch per path, so a `patches` mock can answer any batch. */
const patchesFor = (paths: string[]) =>
  paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n-x\n+y\n`).join('');
const { lspTarget } = await import('@/client/lsp/target.js');

const file = (over: Partial<ChangedFile>): ChangedFile => ({
  path: 'a.py',
  status: 'M',
  additions: 3,
  deletions: 1,
  binary: false,
  blob: 'b2',
  oldBlob: '',
  generated: false,
  ...over,
});

function snap(version: number, key: string, tree: string[] = ['a.txt', 'b.txt']): Snapshot {
  return {
    root: '/r',
    review: { kind: 'range', old: 'HEAD', new: 'worktree', base: 'direct', view: { kind: 'commit', sha: key } },
    follows: 'none',
    commentKey: key,
    version,
    oldSha: 'x',
    newSha: 'worktree',
    headSha: 'h',
    context: 5,
    changed: [],
    tree,
    commit: null,
    commits: { list: [], total: 0, oldSha: 'x', newSha: 'worktree' },
    iterations: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.github.mockReset().mockImplementation(async () => ({
    version: useStore.getState().snapshot?.version,
    repository: 'o/r',
    repositoryUrl: 'https://github.com/o/r',
    pullRequest: null,
    reason: 'No matching pull request',
  }));
  blocksSymbol.mockReset().mockResolvedValue(false);
  api.graph.mockReset();
  useStore.setState({
    treeScope: 'changed',
    connectedFrom: 'changed',
    graph: IDLE_GRAPH,
    focus: null,
    context: false,
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
    const changed = ['a.txt', 'b.txt', 'c.txt'].map((path, i) => file({ path, blob: `b${i + 1}` }));
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
    const changed = ['a.txt', 'b.txt', 'c.txt'].map((path, i) => file({ path, blob: `b${i + 1}` }));
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
    const bin = (path: string) => file({ path, additions: 0, deletions: 0, binary: true, blob: 'b0' });
    const changed = [bin('a.gif'), bin('b.mp4'), file({ path: 'c.txt', blob: 'b1' })];
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

  it('hunk motions start from the active file header when no line is selected', async () => {
    const changed = ['a.py', 'b.py'].map((path) => file({ path, blob: 'b1' }));
    api.patches.mockResolvedValue(patchesFor(['a.py', 'b.py']));
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.py', 'b.py']), changed });
    await useStore.getState().refreshSnapshot();
    // After a whole-file comment on b.py the reader is in b.py without a cursor line.
    useStore.setState({ selection: null, activePath: 'b.py' });
    useStore.getState().moveHunk(-1);
    expect(useStore.getState().selection?.id).toMatch(/^diff:a\.py@/);
    useStore.setState({ selection: null, activePath: 'b.py' });
    useStore.getState().moveHunk(1);
    expect(useStore.getState().selection?.id).toMatch(/^diff:b\.py@/);
    // Without any file to start from, the motions still enter the diff from either end.
    useStore.setState({ selection: null, activePath: null });
    useStore.getState().moveHunk(-1);
    expect(useStore.getState().selection?.id).toMatch(/^diff:b\.py@/);
  });

  it('a watcher refresh keeps the open draft, cursor and search; a mode switch drops them', async () => {
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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

    api.enter.mockResolvedValueOnce(snap(3, 'pr:abc', ['c.txt']));
    await useStore.getState().enter({ kind: 'pr' });
    s = useStore.getState();
    expect(s.draft).toBeNull();
    expect(s.selection).toBeNull();
    expect(s.jumps).toEqual([]);
  });

  it('a reloaded file moves the selection to its new item id', async () => {
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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
    const changed = ['a.txt', 'b.txt', 'c.txt'].map((path) => file({ path, blob: 'b1' }));
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

  it('a reload of another file keeps the draft object, so the composer does not take focus again', async () => {
    const changed = [file({ path: 'b.txt', blob: 'b1' })];
    api.patch.mockResolvedValue(patchesFor(['b.txt']));
    api.file.mockResolvedValue({ contents: 'y\nrest\n', binary: false });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working'), changed });
    await useStore.getState().refreshSnapshot();
    const draft = { path: 'a.txt', selection: null };
    useStore.setState({ draft });
    const id = itemIdOf(useStore.getState(), 'b.txt');
    await new Promise((r) => setTimeout(r, 0));
    expect(itemIdOf(useStore.getState(), 'b.txt')).not.toBe(id);
    expect(useStore.getState().draft).toBe(draft);
    api.patch.mockReset();
  });

  it('a mode switch stops the hydration queue: no further file requests, and the batch in flight is aborted', async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
    const changed = paths.map((path) => file({ path, blob: 'b1' }));
    api.patches.mockImplementation(async (ps: string[]) => patchesFor(ps));
    const pending: Deferred<{ contents: string; binary: boolean }>[] = [];
    api.file.mockImplementation(() => {
      const d = deferred<{ contents: string; binary: boolean }>();
      pending.push(d);
      return d.promise;
    });
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', paths), changed });
    await useStore.getState().refreshSnapshot();
    const issued = api.file.mock.calls.length;
    // Some files are still queued, so a live queue would dequeue more.
    expect(issued).toBeGreaterThan(0);
    expect(issued).toBeLessThan(2 * paths.length);
    const signal = api.file.mock.calls[0]![2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().enter({ kind: 'pr' });
    expect(signal.aborted).toBe(true);
    for (const d of pending) d.resolve({ contents: 'y\nrest\n', binary: false });
    await new Promise((r) => setTimeout(r, 0));
    // The obsolete queue dequeued nothing more, and the stale results were not committed.
    expect(api.file).toHaveBeenCalledTimes(issued);
    expect(useStore.getState().loaded).toEqual({});
    expect(useStore.getState().contents).toEqual({});
    api.patches.mockReset();
  });

  it('a refresh touching five of many files requests only those five', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    api.patches.mockImplementation(async (ps: string[]) => patchesFor(ps));
    api.file.mockResolvedValue({ contents: 'y\n', binary: false });
    api.snapshot.mockResolvedValueOnce({
      ...snap(1, 'working', paths),
      changed: paths.map((path) => file({ path, blob: 'b1' })),
    });
    await useStore.getState().refreshSnapshot();
    expect(Object.keys(useStore.getState().loaded)).toHaveLength(30);
    // The whole review went out in batches of at most PATCH_BATCH_FILES.
    for (const c of api.patches.mock.calls) expect((c[0] as string[]).length).toBeLessThanOrEqual(PATCH_BATCH_FILES);
    api.patches.mockClear();
    api.patch.mockClear();

    const touched = ['f03.txt', 'f07.txt', 'f12.txt', 'f20.txt', 'f29.txt'];
    api.snapshot.mockResolvedValueOnce({
      ...snap(2, 'working', paths),
      changed: paths.map((path) => file({ path, blob: touched.includes(path) ? 'b2' : 'b1' })),
    });
    await useStore.getState().refreshSnapshot();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.patches).toHaveBeenCalledTimes(1);
    expect([...(api.patches.mock.calls[0]![0] as string[])].sort()).toEqual(touched);
    api.patches.mockReset();
  });

  it('a huge file rides its own batch behind the small ones; the active file goes first; an oversized diff waits to be asked for', async () => {
    const sized = (path: string, lines: number) => file({ path, additions: lines, deletions: 0, blob: 'b1' });
    const changed = [
      sized('a.txt', 1),
      sized('big.txt', PATCH_BATCH_LINES + 1),
      sized('c.txt', 1),
      sized('d.txt', 1),
      sized('huge.lock', OVERSIZED_LINES + 1),
      sized('z.txt', 1),
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
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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
    api.enter.mockResolvedValueOnce(snap(4, 'pr:abc', ['c.txt']));
    await useStore.getState().enter({ kind: 'pr' });
    expect(useStore.getState().fileView).toBeNull();
  });

  it('an unchanged file opens in the file view, not in the diff list', async () => {
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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

  it('v moves to the next unviewed file, a collapsed one included; zc moves to the next open file', async () => {
    const changed = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((path, i) => file({ path, blob: `b${i}` }));
    api.patches.mockResolvedValue(patchesFor(['a.txt', 'b.txt', 'c.txt', 'd.txt']));
    api.setViewed.mockImplementation(async (path: string, blob: string, viewed: boolean) => [
      ...useStore.getState().viewed.filter((v) => v.path !== path),
      { path, blob, viewed },
    ]);
    api.viewed.mockResolvedValueOnce([{ path: 'c.txt', blob: 'b2', viewed: true }]);
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt', 'c.txt', 'd.txt']), changed });
    await useStore.getState().boot();
    // b.txt is folded but not viewed: v from a.txt stops on its header instead of skipping to d.txt.
    useStore.setState({ collapsed: { 'b.txt': true }, diffStyle: 'unified' });
    useStore.getState().moveFile('first');
    await useStore.getState().toggleViewedAtCursor();
    expect(useStore.getState().activePath).toBe('b.txt');
    expect(useStore.getState().selection).toBeNull();
    // From b.txt, viewed c.txt is skipped and open d.txt takes the cursor on its first hunk.
    await useStore.getState().toggleViewedAtCursor();
    expect(useStore.getState().activePath).toBe('d.txt');
    expect(useStore.getState().selection).toEqual(
      expect.objectContaining({ id: expect.stringMatching(/^diff:d\.txt@/) }),
    );
    // The last unviewed file stays current once nothing unviewed follows it.
    await useStore.getState().toggleViewedAtCursor();
    expect(useStore.getState().activePath).toBe('d.txt');
    expect(useStore.getState().selection).toBeNull();

    // zc skips collapsed files whatever their viewed state.
    void useStore.getState().setViewedMany(['a.txt', 'b.txt', 'c.txt', 'd.txt'], false);
    useStore.setState({ collapsed: { 'b.txt': true, 'c.txt': true } });
    useStore.getState().moveFile('first');
    useStore.getState().setCollapsedAtCursor(true);
    expect(useStore.getState().activePath).toBe('d.txt');
  });

  it('marking a file viewed by mouse collapses it but leaves cursor and viewport alone', async () => {
    const changed = ['a.txt', 'b.txt', 'c.txt'].map((path, i) => file({ path, blob: `b${i}` }));
    api.patches.mockResolvedValue(patchesFor(['a.txt', 'b.txt', 'c.txt']));
    api.setViewed.mockImplementation(async (path: string, blob: string, viewed: boolean) => [{ path, blob, viewed }]);
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt', 'c.txt']), changed });
    await useStore.getState().boot();
    useStore.setState({ diffStyle: 'unified' });
    // The reader is on a.txt and clicks the Viewed checkbox of b.txt.
    useStore.getState().moveFile('first');
    const before = useStore.getState();
    await useStore.getState().setViewed('b.txt', true);
    const s = useStore.getState();
    expect(viewedState(s, changed[1]!)).toBe('viewed');
    expect(isCollapsed(s, 'b.txt')).toBe(true);
    expect(s.activePath).toBe('a.txt');
    expect(s.selection).toBe(before.selection);
    expect(s.scrollTarget).toBe(before.scrollTarget);
  });

  it('collapsing a file by mouse leaves cursor and viewport alone; clicking its header selects it', async () => {
    const changed = ['a.txt', 'b.txt', 'c.txt'].map((path, i) => file({ path, blob: `b${i}` }));
    api.patches.mockResolvedValue(patchesFor(['a.txt', 'b.txt', 'c.txt']));
    api.snapshot.mockResolvedValueOnce({ ...snap(1, 'working', ['a.txt', 'b.txt', 'c.txt']), changed });
    await useStore.getState().boot();
    useStore.setState({ diffStyle: 'unified' });
    // The reader is on a.txt and clicks b.txt's collapse chevron.
    useStore.getState().moveFile('first');
    const before = useStore.getState();
    useStore.getState().toggleCollapsed('b.txt');
    let s = useStore.getState();
    expect(isCollapsed(s, 'b.txt')).toBe(true);
    expect(s.activePath).toBe('a.txt');
    expect(s.selection).toBe(before.selection);
    expect(s.scrollTarget).toBe(before.scrollTarget);

    // Clicking a header puts the cursor on that file, as J / K do on a collapsed one, without scrolling.
    useStore.getState().selectFile('c.txt');
    s = useStore.getState();
    expect(s).toMatchObject({ activePath: 'c.txt', selection: null });
    expect(s.scrollTarget).toBe(before.scrollTarget);
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
      config: {
        autoViewed: [],
        contextLines: 5,
        followRefs: 'off' as const,
        lineWrap: true,
        lspCommands: {},
        githubHosts: {},
      },
      lsp: LSP_OFF,
    });
    const slow = deferred<Snapshot>();
    api.snapshot.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(snap(2, 'working'));
    api.config.mockResolvedValueOnce({
      autoViewed: ['*.lock'],
      contextLines: 9,
      followRefs: 'off' as const,
      lineWrap: true,
      lspCommands: {},
      githubHosts: {},
    });
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
    api.enter.mockReturnValueOnce(post.promise);
    const switching = useStore.getState().enter({ kind: 'pr' });
    // The server broadcasts the new version before its response returns.
    api.snapshot.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().refreshSnapshot(2);
    let s = useStore.getState();
    expect(s.snapshot?.commentKey).toBe('pr:abc');
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
    api.enter.mockReturnValueOnce(post.promise);
    const switching = useStore.getState().enter({ kind: 'pr' });
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
    const changed = [file({ path: 'a.txt', blob: 'b1' })];
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

    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().enter({ kind: 'pr' });
    expect(useStore.getState().snapshot?.commentKey).toBe('pr:abc');
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
    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().enter({ kind: 'pr' });
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
  it('shortcut 1 compares HEAD to the worktree immediately', () => {
    api.enter.mockResolvedValue(snap(2, 'working'));
    useStore.getState().pickModeEntry(1);
    expect(api.enter).toHaveBeenLastCalledWith({ kind: 'working' });
    expect(useStore.getState().modeMenuOpen).toBe(false);
  });
});

describe('language server log', () => {
  const withLog = (seq: number) => lspStatus('ready', { log: { seq, errors: 0, warnings: 0 } });
  const entry = { id: 1, time: 0, source: 'stderr' as const, level: 'log' as const, message: 'open a.py v1', count: 1 };

  it('fetches a shown log, again when the status says it moved, and forgets it when hidden', async () => {
    useStore.setState({ lsp: withLog(1), lspLogs: {} });
    const before = api.lspLog.mock.calls.length;
    api.lspLog.mockResolvedValueOnce({ entries: [entry] });
    await useStore.getState().watchLspLog('pyrefly lsp', true);
    expect(api.lspLog).toHaveBeenLastCalledWith('pyrefly lsp');
    expect(useStore.getState().lspLogs['pyrefly lsp']).toEqual({ seq: 1, entries: [entry] });
    // The same seq again says nothing moved.
    useStore.getState().setLspStatus(withLog(1));
    expect(api.lspLog.mock.calls.length).toBe(before + 1);
    const more = [entry, { ...entry, id: 2, message: 'close a.py' }];
    api.lspLog.mockResolvedValueOnce({ entries: more });
    useStore.getState().setLspStatus(withLog(2));
    await vi.waitFor(() => expect(useStore.getState().lspLogs['pyrefly lsp']).toEqual({ seq: 2, entries: more }));
    await useStore.getState().watchLspLog('pyrefly lsp', false);
    expect(useStore.getState().lspLogs).toEqual({});
    useStore.getState().setLspStatus(withLog(3));
    expect(api.lspLog.mock.calls.length).toBe(before + 2);
  });

  it('fetches one log at a time, and once more when the status outran the fetch', async () => {
    useStore.setState({ lsp: withLog(1), lspLogs: {} });
    const before = api.lspLog.mock.calls.length;
    const slow = deferred<{ entries: (typeof entry)[] }>();
    api.lspLog.mockReturnValueOnce(slow.promise);
    const shown = useStore.getState().watchLspLog('pyrefly lsp', true);
    useStore.getState().setLspStatus(withLog(2));
    useStore.getState().setLspStatus(withLog(3));
    expect(api.lspLog.mock.calls.length).toBe(before + 1);
    const more = [entry, { ...entry, id: 2, message: 'close a.py' }];
    api.lspLog.mockResolvedValueOnce({ entries: more });
    slow.resolve({ entries: [entry] });
    await shown;
    await vi.waitFor(() => expect(useStore.getState().lspLogs['pyrefly lsp']).toEqual({ seq: 3, entries: more }));
    expect(api.lspLog.mock.calls.length).toBe(before + 2);
  });

  it('lets a hide during the fetch win', async () => {
    useStore.setState({ lsp: withLog(1), lspLogs: {} });
    const slow = deferred<{ entries: (typeof entry)[] }>();
    api.lspLog.mockReturnValueOnce(slow.promise);
    const shown = useStore.getState().watchLspLog('pyrefly lsp', true);
    await useStore.getState().watchLspLog('pyrefly lsp', false);
    slow.resolve({ entries: [entry] });
    await shown;
    expect(useStore.getState().lspLogs).toEqual({});
  });
});

describe('symbol navigation', () => {
  it.each(['json', 'jsonc', 'yaml', 'toml'] as const)(
    '%s keeps hover but does not offer symbol navigation when its server offers none',
    async (language) => {
      const path = `config.${language}`;
      const target = { path, side: 'new' as const, line: 1, col: 2, text: 'name' };
      useStore.setState({
        snapshot: snap(1, 'working', [path]),
        lsp: lspStatus('ready', { languages: [language], supports: ['hover', 'documentSymbol'] }),
        symbolMenu: null,
        hover: null,
      });
      const state = useStore.getState();
      await state.openSymbolMenu(target, 10, 20);
      await state.goToDefinition(target);
      await state.goToTypeDefinition(target);
      await state.findReferences(target);
      expect(useStore.getState().symbolMenu).toBeNull();
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

  it('asks for a hover inside prose anyway when a server joins the language', async () => {
    ready();
    const joiner = {
      ...lspStatus('ready').servers[0]!,
      name: 'tailwind',
      command: 'tailwind',
      languages: [],
      joins: ['python' as const],
    };
    useStore.setState({
      symbolMenu: null,
      hover: null,
      lsp: { enabled: true, servers: [...lspStatus('ready').servers, joiner], missing: [] },
    });
    blocksSymbol.mockResolvedValue(true);
    api.lspHover.mockResolvedValue({ contents: '.foo { margin: 0 }' });
    const anchor = { left: 0, top: 0, bottom: 0 };
    await useStore.getState().requestHover(target, anchor);
    expect(blocksSymbol).not.toHaveBeenCalled();
    expect(useStore.getState().hover).toEqual({ target, contents: '.foo { margin: 0 }', anchor });
    // A joining server still starting is no reason to skip the gate.
    useStore.setState({
      hover: null,
      lsp: { enabled: true, servers: [...lspStatus('ready').servers, { ...joiner, state: 'starting' }], missing: [] },
    });
    await useStore.getState().requestHover(target, anchor);
    expect(blocksSymbol).toHaveBeenCalledTimes(1);
    expect(useStore.getState().hover).toBeNull();
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
  });

  it('drops syntax answers across a mode switch', async () => {
    ready();
    useStore.setState({ symbolMenu: null, hover: null });
    const slow = deferred<boolean>();
    blocksSymbol.mockReturnValue(slow.promise);
    const hover = useStore.getState().requestHover(target, { left: 0, top: 0, bottom: 0 });
    const menu = useStore.getState().openSymbolMenu(target, 1, 2);
    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.txt']));
    await useStore.getState().enter({ kind: 'pr' });
    slow.resolve(false);
    await Promise.all([hover, menu]);
    expect(api.lspHover).not.toHaveBeenCalled();
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

  it('the symbol menu opens once the grammar clears the token, and stays shut on a keyword', async () => {
    ready();
    useStore.setState({ symbolMenu: null });
    blocksSymbol.mockResolvedValueOnce(true);
    await useStore.getState().openSymbolMenu({ ...target, text: 'if' }, 1, 2);
    expect(blocksSymbol).toHaveBeenLastCalledWith('a.py', 'new', 3, 4, expect.any(Function));
    expect(useStore.getState().symbolMenu).toBeNull();
    await useStore.getState().openSymbolMenu(target, 1, 2);
    expect(useStore.getState().symbolMenu).toEqual({ target, x: 1, y: 2 });
    // A close while the grammar's answer is in flight wins over the late answer.
    useStore.getState().closeSymbolMenu();
    const slow = deferred<boolean>();
    blocksSymbol.mockReturnValueOnce(slow.promise);
    const opening = useStore.getState().openSymbolMenu(target, 1, 2);
    useStore.getState().closeSymbolMenu();
    slow.resolve(false);
    await opening;
    expect(useStore.getState().symbolMenu).toBeNull();
    // Started with --no-lsp: nothing the menu offers can work, so there is no menu.
    useStore.setState({ lsp: LSP_OFF });
    await useStore.getState().openSymbolMenu(target, 1, 2);
    expect(useStore.getState().symbolMenu).toBeNull();
    // A server that is starting or broken still gets a menu, whose actions explain the blocker.
    useStore.setState({ lsp: lspStatus('unavailable', { message: 'boom' }) });
    await useStore.getState().openSymbolMenu(target, 1, 2);
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
    // No comments on it, but navigation goes on from it: the server that named it is asked by its absolute path.
    await useStore.getState().openDraft(s.selection!);
    expect(useStore.getState().draft).toBeNull();
    expect(useStore.getState().toast).toMatch(/repository files only/);
    api.lspDefinition.mockClear();
    await useStore.getState().goToDefinition({ ...target, path: site });
    expect(api.lspDefinition).toHaveBeenCalledWith({ path: site, line: 3, col: 4 });
    api.lspSymbols.mockResolvedValue({ symbols: [] });
    await useStore.getState().openSymbols('document');
    expect(api.lspSymbols).toHaveBeenCalledWith({ path: site });
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

  it('go to definition on the definition itself lists its references instead', async () => {
    ready();
    api.lspDefinition.mockResolvedValue({ locations: [{ path: 'a.py', line: 3, col: 4, text: 'def foo():' }] });
    api.lspReferences.mockResolvedValue({
      locations: [
        { path: 'a.py', line: 3, col: 4, text: 'def foo():' },
        { path: 'b.py', line: 2, col: 0, text: 'foo()' },
      ],
    });
    await useStore.getState().goToDefinition(target);
    expect(api.lspReferences).toHaveBeenCalledWith({ path: 'a.py', line: 3, col: 4 });
    const s = useStore.getState();
    expect(s.references).toMatchObject({ open: true, kind: 'references', symbol: 'foo', index: 1 });
    expect(s.fileView).toBeNull();
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
    expect(api.search).toHaveBeenCalledWith('foo', { word: true, scope: 'repo', content: 'full' });
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

  it('/ pins the current file and remembers content modes independently from global search', async () => {
    ready();
    useStore.setState({ activePath: 'b.py' });
    api.search.mockResolvedValue({ query: 'x', matches: [{ path: 'b.py', line: 2, text: 'y = 2' }], truncated: false });

    useStore.getState().openSearch('file');
    expect(useStore.getState().search.scope).toBe('file');
    expect(useStore.getState().search.path).toBe('b.py');
    expect(useStore.getState().search.editing).toBe(true);
    expect(useStore.getState().scrollTarget).toMatchObject({ id: 'file:b.py@0', align: 'start' });
    const openingNonce = useStore.getState().scrollTarget!.nonce;
    useStore.getState().openSearch('file');
    expect(useStore.getState().scrollTarget!.nonce).toBe(openingNonce + 1);
    // Scrolling to another file must not retarget the search living in b.py's header.
    useStore.setState({ activePath: 'a.py' });
    await useStore.getState().runSearch('y');
    await new Promise((r) => setTimeout(r, 0));
    expect(api.search).toHaveBeenCalledWith('y', {
      ignoreCase: true,
      regex: false,
      scope: 'file',
      content: 'diff',
      path: 'b.py',
    });
    let s = useStore.getState();
    expect(s.search.path).toBe('b.py');
    expect(s.search.input).toBe('y');
    expect(s.search.editing).toBe(false);
    expect(s.search.index).toBe(0);
    expect(s.selection?.range.end).toBe(2);

    useStore.getState().setSearchOptions({ content: 'full' });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.search).toHaveBeenLastCalledWith('y', {
      ignoreCase: true,
      regex: false,
      scope: 'file',
      content: 'full',
      path: 'b.py',
    });
    expect(useStore.getState().search.path).toBe('b.py');
    expect(useStore.getState().search.scope).toBe('file');
    useStore.getState().openSearch('diff');
    await useStore.getState().runSearch('y');
    expect(api.search).toHaveBeenLastCalledWith('y', {
      ignoreCase: true,
      regex: false,
      scope: 'diff',
      content: 'diff',
    });
    useStore.getState().setSearchOptions({ content: 'full' });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.search).toHaveBeenLastCalledWith('y', {
      ignoreCase: true,
      regex: false,
      scope: 'diff',
      content: 'full',
    });
    useStore.getState().openSearch('file');
    expect(useStore.getState().search.content.file).toBe('full');
    useStore.getState().setSearchOptions({ content: 'diff' });
    expect(useStore.getState().search.content.diff).toBe('full');
    useStore.getState().closeSearch();
    useStore.setState((s) => ({ search: { ...s.search, scope: 'diff', content: { file: 'diff', diff: 'diff' } } }));
  });

  it('a prefill replaces the search input; reopening without one keeps it', () => {
    ready();
    useStore.setState({ activePath: 'b.py' });
    useStore.getState().openSearch('file', 'total');
    expect(useStore.getState().search.input).toBe('total');
    useStore.getState().openSearch('file');
    expect(useStore.getState().search.input).toBe('total');
    useStore.getState().openSearch('diff', 'amount');
    expect(useStore.getState().search.input).toBe('amount');
    useStore.getState().closeSearch();
    useStore.setState((s) => ({ search: { ...s.search, scope: 'diff', input: '' } }));
  });

  it('a key typed into a prefilled search replaces the selected prefill', () => {
    ready();
    useStore.setState({ activePath: 'b.py' });
    useStore.getState().openSearch('file', 'total');
    expect(useStore.getState().search.selected).toBe(true);
    useStore.getState().typeSearchInput('x');
    useStore.getState().typeSearchInput('y');
    expect(useStore.getState().search).toMatchObject({ input: 'xy', selected: false });
    useStore.getState().openSearch('file');
    expect(useStore.getState().search.selected).toBe(false);
    useStore.getState().closeSearch();
    useStore.setState((s) => ({ search: { ...s.search, scope: 'diff', input: '' } }));
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
      api.lspSymbols.mockResolvedValue({ symbols: [sym] });
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
});

const thread = (
  over: Partial<Omit<CommentThread, 'anchor'>> & { anchor?: Partial<CommentThread['anchor']> },
): CommentThread => ({
  id: over.id ?? 't',
  anchor: { kind: 'line', path: 'a.py', side: 'new', startLine: 1, endLine: 1, quoted: 'x', ...over.anchor },
  messages: [{ id: 'm', body: 'b', createdAt: 1, updatedAt: 1 }],
  resolved: over.resolved ?? false,
  stale: false,
});

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

  it('opening local search drops a pending global result without moving the cursor', async () => {
    ready();
    useStore.getState().openSearch('diff');
    const slow = deferred<SearchResponse>();
    api.search.mockReturnValueOnce(slow.promise);
    const run = useStore.getState().runSearch('foo');
    useStore.getState().openSearch('file');
    const selection = useStore.getState().selection;
    slow.resolve(hit('b.py', 2));
    await run;
    expect(useStore.getState().search.scope).toBe('file');
    expect(useStore.getState().search.matches).toEqual([]);
    expect(useStore.getState().search.loading).toBe(false);
    expect(useStore.getState().selection).toBe(selection);
    useStore.getState().closeSearch();
    useStore.setState((s) => ({ search: { ...s.search, scope: 'diff' } }));
  });

  it('a word search completing after a mode switch is dropped', async () => {
    ready();
    lspTarget.focus({ path: 'a.py', side: 'new', line: 3, col: 4, text: 'foo' });
    const slow = deferred<SearchResponse>();
    api.search.mockReturnValueOnce(slow.promise);
    const run = useStore.getState().searchWord(1);
    lspTarget.focus(null);
    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['b.py']));
    await useStore.getState().enter({ kind: 'pr' });
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
    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['b.py']));
    await useStore.getState().enter({ kind: 'pr' });
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
    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['b.py']));
    await useStore.getState().enter({ kind: 'pr' });
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
    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.py']));
    await useStore.getState().enter({ kind: 'pr' });
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
    api.enter.mockResolvedValueOnce(snap(2, 'pr:abc', ['c.py']));
    await useStore.getState().enter({ kind: 'pr' });
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
    const cfg = (contextLines: number): UserConfig => ({
      autoViewed: [],
      contextLines,
      followRefs: 'off',
      lineWrap: true,
      lspCommands: {},
      githubHosts: {},
    });
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

  it('a file draft has no selection, posts a thread without a line, and closes on Escape', async () => {
    useStore.setState({ snapshot: snap(1, 'working', ['a.py']), threads: [], replyTo: 't1' });
    const sel = {
      id: 'diff:a.py@0',
      range: { start: 2, side: 'additions' as const, end: 2, endSide: 'additions' as const },
    };
    useStore.setState({ selection: { ...sel, id: 'diff:b.py@0' } });
    useStore.getState().openFileDraft('a.py');
    let s = useStore.getState();
    expect(s.draft).toEqual({ path: 'a.py', selection: null });
    // A cursor in another file gives way; one inside the file stays put.
    expect(s.selection).toBeNull();
    expect(s.replyTo).toBeNull();
    expect(s.activePath).toBe('a.py');
    // The composer sits above line 1; the pane brings the file's top into view unless it is already there.
    expect(s.scrollTarget).toEqual({
      id: itemIdOf(s, 'a.py'),
      align: 'start',
      unlessVisible: 'top',
      nonce: expect.any(Number),
    });
    useStore.setState({ selection: sel });
    useStore.getState().openFileDraft('a.py');
    expect(useStore.getState().selection).toEqual(sel);
    useStore.setState({ selection: null });
    // The item re-renders for the composer, and again once it is gone.
    const version = (prev?: ReturnType<typeof itemVersion>) =>
      itemVersion(prev, itemDeps(useStore.getState(), 'a.py', [], false));
    const open = version();
    expect(await useStore.getState().draftQuote()).toBe('');
    api.addThread.mockResolvedValue([]);
    api.threads.mockResolvedValueOnce([thread({ id: 'f', anchor: { kind: 'file', path: 'a.py' } as never })]);
    await useStore.getState().submitDraft('Split this module.');
    expect(api.addThread).toHaveBeenCalledWith({ path: 'a.py', body: 'Split this module.' });
    s = useStore.getState();
    expect(s.draft).toBeNull();
    expect(s.threads.map((t) => t.anchor.kind)).toEqual(['file']);
    expect(version(open).version).toBe(open.version + 1);

    useStore.getState().openFileDraft('a.py');
    useStore.getState().escape();
    expect(useStore.getState().draft).toBeNull();
    // Not on a file outside the repository.
    useStore.setState({
      fileView: { path: '/usr/lib/os.py', external: true, item: null, from: { position: null, activePath: null } },
    });
    useStore.getState().openFileDraft('/usr/lib/os.py');
    expect(useStore.getState().draft).toBeNull();
    expect(useStore.getState().toast).toMatch(/repository files only/);
    useStore.setState({ fileView: null });
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
    // Cancelling the draft keeps the cursor on its lines.
    expect(useStore.getState().selection?.range.start).toBe(2);
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
  it('switching split / unified keeps the cursor and issues no jump: the pane holds the viewport', () => {
    const selection = {
      id: 'diff:a.py@1',
      range: { start: 3, side: 'additions' as const, end: 3, endSide: 'additions' as const },
    };
    useStore.setState({ selection, scrollTarget: null, diffStyle: 'split' });
    useStore.getState().setDiffStyle('unified');
    const s = useStore.getState();
    expect(s.diffStyle).toBe('unified');
    expect(s.selection).toEqual(selection);
    expect(s.scrollTarget).toBeNull();
  });
});

describe('goToLine', () => {
  it('moves the cursor to that line of the active file and records the origin', async () => {
    const at = (path: string) => file({ path, blob: `b-${path}` });
    api.patch.mockImplementation(
      async (path: string) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n x\n-y\n+foo\n z\n`,
    );
    api.snapshot.mockResolvedValueOnce({
      ...snap(1, 'working', ['a.py', 'b.py']),
      changed: [at('a.py'), at('b.py')],
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
    const at = (path: string) => file({ path, blob: `b-${path}` });
    api.patch.mockImplementation(
      async (path: string) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n x\n-y\n+foo\n z\n`,
    );
    api.snapshot.mockResolvedValueOnce({
      ...snap(1, 'working', ['a.py', 'b.py']),
      changed: [at('a.py'), at('b.py')],
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
    lookup.resolve({
      version: 1,
      repository: 'o/r',
      repositoryUrl: 'https://github.com/o/r',
      pullRequest: null,
      reason: 'No PR',
    });
    await vi.waitFor(() => expect(useStore.getState().github.status).toBe('ready'));
  });

  it('discards a slow lookup after another comparison has loaded', async () => {
    const old = deferred<GithubMetadata>();
    api.github.mockReturnValueOnce(old.promise);
    api.snapshot.mockResolvedValueOnce(snap(1, 'first'));
    await useStore.getState().boot();
    api.enter.mockResolvedValueOnce(snap(2, 'second'));
    await useStore.getState().enter({ kind: 'revspec', args: ['main'] });
    await vi.waitFor(() => expect(useStore.getState().github.data?.version).toBe(2));
    old.resolve({
      version: 1,
      repository: 'o/r',
      repositoryUrl: 'https://github.com/o/r',
      pullRequest: null,
      reason: null,
    });
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
  api.enter.mockRejectedValueOnce(new Error('unknown revision'));
  await useStore.getState().enter({ kind: 'revspec', args: ['missing'] });
  await vi.waitFor(() => expect(useStore.getState().github.status).toBe('ready'));
  expect(useStore.getState().github.data?.version).toBe(1);
  pending.resolve({
    version: 1,
    repository: 'o/r',
    repositoryUrl: 'https://github.com/o/r',
    pullRequest: null,
    reason: null,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(useStore.getState().github.data?.reason).toBe('No matching pull request');
});

it('discards metadata for a newer server snapshot without changing the displayed comparison', async () => {
  api.snapshot.mockResolvedValueOnce(snap(1, 'first'));
  api.github.mockResolvedValueOnce({
    version: 2,
    repository: 'o/r',
    repositoryUrl: 'https://github.com/o/r',
    pullRequest: null,
    reason: null,
  });
  await useStore.getState().boot();
  await vi.waitFor(() => expect(useStore.getState().github.status).toBe('idle'));
  expect(useStore.getState().snapshot?.version).toBe(1);
  expect(useStore.getState().github.data).toBeUndefined();
});

describe('connected scope', () => {
  // Tree order: a/x, a/y, b/w, b/z, c/solo, d.md.
  const FILES = ['a/x.ts', 'a/y.ts', 'b/w.ts', 'b/z.ts', 'c/solo.ts', 'd.md'];
  const cluster = (id: string, files: string[]) => ({
    id,
    label: '',
    files,
    symbols: files.length,
    context: [],
    contextTotal: 0,
    links: [],
    linksTotal: 0,
  });
  const graphOf = (
    version: number,
    clusters = [cluster('a/x.ts', ['a/x.ts', 'a/y.ts']), cluster('b/w.ts', ['b/w.ts', 'b/z.ts'])],
  ): GraphResponse => ({
    version,
    clusters,
    unlinked: ['c/solo.ts'],
    other: ['d.md'],
  });
  const snapshotAt = (version: number, key = 'working') => ({
    ...snap(version, key, FILES),
    changed: FILES.map((path) => file({ path, blob: `b-${path}` })),
  });
  async function open(version = 1) {
    api.patch.mockImplementation(async (p: string) => patchesFor([p]));
    api.patches.mockImplementation(async (paths: string[]) => patchesFor(paths));
    api.snapshot.mockResolvedValueOnce(snapshotAt(version));
    await useStore.getState().refreshSnapshot();
  }
  /** Enter Connected with `graph` as the server's answer and wait for the first focus. */
  async function connect(graph: GraphResponse) {
    api.graph.mockResolvedValueOnce(graph);
    useStore.getState().setTreeScope('connected');
    await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('ready'));
  }
  const focusedPaths = () => listedPaths(useStore.getState());

  it('entering Connected loads the graph, then focuses the first cluster and lists only its files', async () => {
    await open();
    const answer = deferred<GraphResponse>();
    api.graph.mockReturnValueOnce(answer.promise);
    useStore.getState().setTreeScope('connected');
    expect(useStore.getState().treeScope).toBe('connected');
    expect(useStore.getState().graph).toEqual({ status: 'loading', data: null, error: null });
    expect(useStore.getState().focus).toBeNull();
    expect(focusedPaths()).toEqual(FILES);

    answer.resolve(graphOf(1));
    await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('ready'));
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'a/x.ts' });
    expect(focusedPaths()).toEqual(['a/x.ts', 'a/y.ts']);
    // Narrowing the list does not stop the other clusters' patches from loading.
    await vi.waitFor(() => expect(Object.keys(useStore.getState().loaded)).toHaveLength(FILES.length));
  });

  it('focuses unlinked, then other, when the graph has no clusters', async () => {
    await open();
    await connect({ ...graphOf(1, []), unlinked: [] });
    expect(useStore.getState().focus).toEqual({ kind: 'other' });
    expect(focusedPaths()).toEqual(['d.md']);
  });

  it('drops a response built for another snapshot version and asks again', async () => {
    await open(2);
    api.graph.mockResolvedValueOnce(graphOf(1, [cluster('stale.ts', ['a/x.ts'])])).mockResolvedValueOnce(graphOf(2));
    useStore.getState().setTreeScope('connected');
    await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('ready'));
    expect(api.graph).toHaveBeenCalledTimes(2);
    expect(useStore.getState().graph.data?.version).toBe(2);
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'a/x.ts' });
  });

  it('stops asking after a few stale answers and reports the graph as out of date', async () => {
    await open(2);
    api.graph.mockResolvedValue(graphOf(1));
    useStore.getState().setTreeScope('connected');
    await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('error'));
    expect(api.graph.mock.calls.length).toBeGreaterThan(1);
    expect(api.graph.mock.calls.length).toBeLessThan(10);
    expect(useStore.getState().graph.data).toBeNull();
    expect(useStore.getState().focus).toBeNull();
    expect(useStore.getState().toast).toContain('Loading the connected graph failed');
  });

  it('a failed load toasts, keeps the error on the graph, and loadGraph again retries', async () => {
    await open();
    api.graph.mockRejectedValueOnce(new Error('boom'));
    useStore.getState().setTreeScope('connected');
    await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('error'));
    expect(useStore.getState().graph.error).toBe('boom');
    expect(useStore.getState().toast).toBe('Loading the connected graph failed: boom');

    api.graph.mockResolvedValueOnce(graphOf(1));
    await useStore.getState().loadGraph();
    expect(useStore.getState().graph).toEqual({ status: 'ready', data: graphOf(1), error: null });
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'a/x.ts' });
  });

  it('leaving Connected aborts the request in flight and a late answer lands nowhere', async () => {
    await open();
    const answer = deferred<GraphResponse>();
    let signal: AbortSignal | undefined;
    api.graph.mockImplementationOnce((s: AbortSignal) => {
      signal = s;
      return answer.promise;
    });
    useStore.getState().setTreeScope('connected');
    expect(signal?.aborted).toBe(false);
    useStore.getState().setTreeScope('all');
    expect(signal?.aborted).toBe(true);
    expect(useStore.getState().graph).toEqual(IDLE_GRAPH);

    answer.resolve(graphOf(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(useStore.getState().graph).toEqual(IDLE_GRAPH);
    expect(useStore.getState().focus).toBeNull();
  });

  it('leaving Connected clears the focus and lists every changed file again', async () => {
    await open();
    await connect(graphOf(1));
    expect(focusedPaths()).toHaveLength(2);
    useStore.getState().setTreeScope('changed');
    expect(useStore.getState().focus).toBeNull();
    expect(useStore.getState().graph).toEqual(IDLE_GRAPH);
    expect(focusedPaths()).toEqual(FILES);
  });

  describe('the graph dialog flag', () => {
    const A = { kind: 'cluster', id: 'a/x.ts' } as const;
    const isOpen = () => useStore.getState().graphOpen;

    it('opens only on a focused cluster of the Connected scope', async () => {
      await open();
      useStore.getState().setGraphOpen(true);
      expect(isOpen()).toBe(false);
      await connect(graphOf(1));
      useStore.getState().focusCluster({ kind: 'unlinked' });
      useStore.getState().setGraphOpen(true);
      expect(isOpen()).toBe(false);
      useStore.getState().focusCluster(A);
      useStore.getState().setGraphOpen(true);
      expect(isOpen()).toBe(true);
      useStore.getState().setGraphOpen(false);
      expect(isOpen()).toBe(false);
    });

    it('closes when the focus moves to another group or to none', async () => {
      await open();
      await connect(graphOf(1));
      for (const next of [{ kind: 'cluster', id: 'b/w.ts' } as const, { kind: 'other' } as const, null]) {
        useStore.getState().focusCluster(A);
        useStore.getState().setGraphOpen(true);
        useStore.getState().focusCluster(next);
        expect(isOpen()).toBe(false);
      }
    });

    it('survives a refresh that keeps the cluster and closes when the refresh drops it', async () => {
      await open();
      await connect(graphOf(1));
      useStore.getState().setGraphOpen(true);
      api.graph.mockResolvedValueOnce(graphOf(1));
      await useStore.getState().loadGraph();
      expect(isOpen()).toBe(true);
      api.graph.mockResolvedValueOnce(graphOf(1, [cluster('b/w.ts', ['b/w.ts', 'b/z.ts'])]));
      await useStore.getState().loadGraph();
      expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'b/w.ts' });
      expect(isOpen()).toBe(false);
    });

    it('closes when Connected is left, and Escape closes it without clearing the review selection', async () => {
      await open();
      await connect(graphOf(1));
      useStore.getState().setGraphOpen(true);
      useStore.getState().setTreeScope('changed');
      expect(isOpen()).toBe(false);

      await connect(graphOf(1));
      const selection = useStore.getState().selection;
      useStore.getState().setGraphOpen(true);
      useStore.getState().escape();
      expect(isOpen()).toBe(false);
      expect(useStore.getState().selection).toBe(selection);
    });
  });

  it('an answer that lands after a newer transition is dropped for the newer one’s', async () => {
    await open();
    const slow = deferred<GraphResponse>();
    api.graph.mockReturnValueOnce(slow.promise);
    useStore.getState().setTreeScope('connected');
    // A mode switch begins a transition and reloads the graph for the new snapshot.
    api.graph.mockResolvedValueOnce({ ...graphOf(2), clusters: [cluster('b/w.ts', ['b/w.ts', 'b/z.ts'])] });
    api.enter.mockResolvedValueOnce(snapshotAt(2, 'pr:abc'));
    await useStore.getState().enter({ kind: 'pr' });
    await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('ready'));

    slow.resolve(graphOf(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(useStore.getState().graph.data?.version).toBe(2);
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'b/w.ts' });
  });

  it('a mode switch resets the graph and the focus, then loads the graph of the new mode', async () => {
    await open();
    await connect(graphOf(1));
    useStore.getState().moveCluster(1);
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'b/w.ts' });

    const answer = deferred<GraphResponse>();
    api.graph.mockReturnValueOnce(answer.promise);
    api.enter.mockResolvedValueOnce(snapshotAt(2, 'pr:abc'));
    await useStore.getState().enter({ kind: 'pr' });
    expect(useStore.getState().graph).toEqual({ status: 'loading', data: null, error: null });
    expect(useStore.getState().focus).toBeNull();
    expect(useStore.getState().treeScope).toBe('connected');

    answer.resolve(graphOf(2));
    await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('ready'));
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'a/x.ts' });
  });

  it('a refresh that bumps the version reloads the graph and keeps the focus while its id exists', async () => {
    await open();
    await connect(graphOf(1));
    useStore.getState().moveCluster(1);

    api.graph.mockResolvedValueOnce(graphOf(2));
    api.snapshot.mockResolvedValueOnce(snapshotAt(2));
    await useStore.getState().refreshSnapshot();
    await vi.waitFor(() => expect(useStore.getState().graph.data?.version).toBe(2));
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'b/w.ts' });
    expect(focusedPaths()).toEqual(['b/w.ts', 'b/z.ts']);
  });

  it('a refresh that removes the focused cluster focuses the first group', async () => {
    await open();
    await connect(graphOf(1));
    useStore.getState().moveCluster(1);
    useStore.setState({ activePath: 'b/z.ts' });

    api.graph.mockResolvedValueOnce(graphOf(2, [cluster('a/x.ts', ['a/x.ts', 'a/y.ts'])]));
    api.snapshot.mockResolvedValueOnce(snapshotAt(2));
    await useStore.getState().refreshSnapshot();
    await vi.waitFor(() => expect(useStore.getState().graph.data?.version).toBe(2));
    expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'a/x.ts' });
    // The reader's file left the list: the cursor followed it to the first listed one.
    expect(useStore.getState().activePath).toBe('a/x.ts');
  });

  it('a refresh that keeps the version does not ask for the graph again', async () => {
    await open();
    await connect(graphOf(1));
    api.snapshot.mockResolvedValueOnce(snapshotAt(1));
    await useStore.getState().refreshSnapshot();
    expect(api.graph).toHaveBeenCalledTimes(1);
    expect(useStore.getState().graph.status).toBe('ready');
  });

  it('J / K and ] / [ walk the focused cluster and stop at its ends', async () => {
    await open();
    await connect(graphOf(1));
    const store = useStore.getState();
    const at = () => useStore.getState().activePath;

    store.moveFile('first');
    expect(at()).toBe('a/x.ts');
    store.moveFile(1);
    expect(at()).toBe('a/y.ts');
    store.moveFile(1);
    expect(at()).toBe('a/y.ts');
    store.moveFile('last');
    expect(at()).toBe('a/y.ts');
    store.moveFile(-1);
    store.moveFile(-1);
    expect(at()).toBe('a/x.ts');

    await vi.waitFor(() => expect(useStore.getState().loaded['a/y.ts']?.kind).toBe('diff'));
    store.moveFile('first');
    store.moveHunk(1);
    store.moveHunk(1);
    expect(at()).toBe('a/y.ts');
    store.moveHunk(1);
    expect(at()).toBe('a/y.ts');
    store.moveHunk(-1);
    store.moveHunk(-1);
    store.moveHunk(-1);
    expect(at()).toBe('a/x.ts');
  });

  it('the cursor moves to the first listed file, header first, when the active file leaves the list', async () => {
    await open();
    await connect(graphOf(1));
    await vi.waitFor(() => expect(useStore.getState().loaded['b/z.ts']?.kind).toBe('diff'));
    const store = useStore.getState();
    store.focusCluster({ kind: 'cluster', id: 'b/w.ts' });
    store.moveFile('last');
    expect(useStore.getState().activePath).toBe('b/z.ts');
    const jumps = useStore.getState().jumps;

    store.focusCluster({ kind: 'cluster', id: 'a/x.ts' });
    const s = useStore.getState();
    expect(s.activePath).toBe('a/x.ts');
    expect(s.scrollTarget).toEqual(expect.objectContaining({ id: itemIdOf(s, 'a/x.ts'), align: 'start' }));
    expect(s.selection?.id).toBe(itemIdOf(s, 'a/x.ts'));
    // The path that left was not a place the reader chose to leave: no jumplist entry names it.
    expect(s.jumps).toEqual(jumps);
  });

  it('the cursor stays where it is when the active file is still listed', async () => {
    await open();
    await connect(graphOf(1));
    const store = useStore.getState();
    store.moveFile('last');
    const before = useStore.getState();
    expect(before.activePath).toBe('a/y.ts');
    store.focusCluster(null);
    expect(useStore.getState().activePath).toBe('a/y.ts');
    expect(useStore.getState().scrollTarget).toBe(before.scrollTarget);
    expect(focusedPaths()).toEqual(FILES);
  });

  it('a draft on a file that left the list is closed', async () => {
    await open();
    await connect(graphOf(1));
    useStore.setState({ activePath: 'b/z.ts', draft: { path: 'b/z.ts', selection: null }, visualAnchor: null });
    useStore.getState().focusCluster({ kind: 'cluster', id: 'a/x.ts' });
    expect(useStore.getState().draft).toBeNull();
  });

  it('moveCluster cycles clusters, unlinked and other, and toggleContext flips the flag', async () => {
    await open();
    await connect(graphOf(1));
    const focus = () => useStore.getState().focus;
    useStore.getState().moveCluster(1);
    expect(focus()).toEqual({ kind: 'cluster', id: 'b/w.ts' });
    useStore.getState().moveCluster(1);
    expect(focus()).toEqual({ kind: 'unlinked' });
    expect(focusedPaths()).toEqual(['c/solo.ts']);
    useStore.getState().moveCluster(1);
    expect(focus()).toEqual({ kind: 'other' });
    useStore.getState().moveCluster(1);
    expect(focus()).toEqual({ kind: 'cluster', id: 'a/x.ts' });
    useStore.getState().moveCluster(-1);
    expect(focus()).toEqual({ kind: 'other' });

    expect(useStore.getState().context).toBe(false);
    useStore.getState().toggleContext();
    expect(useStore.getState().context).toBe(true);
    useStore.getState().toggleContext();
    expect(useStore.getState().context).toBe(false);
  });

  it('moveCluster does nothing before a graph is ready', async () => {
    await open();
    useStore.getState().moveCluster(1);
    expect(useStore.getState().focus).toBeNull();
  });

  it('viewing a directory marks every file under it, whatever the focus', async () => {
    await open();
    await connect(graphOf(1));
    api.setViewedBulk.mockResolvedValue([]);
    await useStore.getState().setViewedMany(FILES, true);
    expect(api.setViewedBulk).toHaveBeenCalledTimes(1);
    expect(api.setViewedBulk.mock.calls[0]![0]).toHaveLength(FILES.length);
  });

  describe('jumps across clusters', () => {
    const focusOf = () => useStore.getState().focus;
    const B = { kind: 'cluster', id: 'b/w.ts' } as const;
    const A = { kind: 'cluster', id: 'a/x.ts' } as const;
    async function inClusterA() {
      await open();
      await connect(graphOf(1));
      await vi.waitFor(() => expect(useStore.getState().loaded['b/z.ts']?.kind).toBe('diff'));
    }

    it('opening a changed file of another cluster widens the focus to its cluster and lands on the file', async () => {
      await inClusterA();
      expect(focusOf()).toEqual(A);
      await useStore.getState().openFile('b/z.ts');
      const s = useStore.getState();
      expect(s.focus).toEqual(B);
      expect(reviewPaths(s)).toEqual(['b/w.ts', 'b/z.ts']);
      expect(s.activePath).toBe('b/z.ts');
      expect(s.scrollTarget).toEqual(expect.objectContaining({ id: itemIdOf(s, 'b/z.ts') }));
    });

    it('a file the graph does not know, or one in a bucket, widens to no focus or to the bucket', async () => {
      await inClusterA();
      await useStore.getState().openFile('c/solo.ts');
      expect(focusOf()).toEqual({ kind: 'unlinked' });
      expect(useStore.getState().activePath).toBe('c/solo.ts');
      // The graph predates the file: it names no group for it.
      useStore.setState({ graph: { status: 'ready', data: { ...graphOf(1), unlinked: [] }, error: null }, focus: A });
      await useStore.getState().openFile('c/solo.ts');
      expect(focusOf()).toBeNull();
      expect(reviewPaths(useStore.getState())).toEqual(FILES);
      expect(useStore.getState().activePath).toBe('c/solo.ts');
    });

    it('keeps the focus for a file it already lists', async () => {
      await inClusterA();
      await useStore.getState().openFile('a/y.ts');
      expect(focusOf()).toEqual(A);
      expect(useStore.getState().activePath).toBe('a/y.ts');
    });

    it('gd, a hover link or a reference onto another cluster’s line widens the focus and puts the cursor on that line', async () => {
      await inClusterA();
      await useStore.getState().goToLink('b/z.ts', 1);
      const s = useStore.getState();
      expect(s.focus).toEqual(B);
      expect(s.activePath).toBe('b/z.ts');
      expect(s.selection).toEqual({
        id: itemIdOf(s, 'b/z.ts'),
        range: { start: 1, side: 'additions', end: 1, endSide: 'additions' },
      });
      expect(s.scrollTarget).toEqual(expect.objectContaining({ id: itemIdOf(s, 'b/z.ts'), align: 'eye' }));
    });

    it('records the jump at the origin once, not at the file the widened focus parks the cursor on', async () => {
      await inClusterA();
      await useStore.getState().goToLink('a/y.ts', 1);
      expect(useStore.getState().jumps).toEqual([]);
      await useStore.getState().goToLink('b/z.ts', 1);
      expect(useStore.getState().jumps).toEqual([{ path: 'a/y.ts', side: 'new', line: 1 }]);
      useStore.setState({ jumps: [], jumpIndex: 0 });
      await useStore.getState().openFile('a/x.ts');
      expect(useStore.getState().jumps).toEqual([{ path: 'b/z.ts', side: 'new', line: 1 }]);
    });

    it('stepping a search match onto another cluster widens the focus first', async () => {
      await inClusterA();
      useStore.setState((s) => ({
        search: { ...s.search, matches: [{ path: 'b/w.ts', line: 1, text: 'y' }], index: -1, direction: 1 },
      }));
      useStore.getState().moveMatch(1);
      await vi.waitFor(() => expect(focusOf()).toEqual(B));
      await vi.waitFor(() => expect(useStore.getState().selection?.id).toBe(itemIdOf(useStore.getState(), 'b/w.ts')));
      expect(useStore.getState().activePath).toBe('b/w.ts');
    });

    it('Ctrl+o onto a position recorded under another focus widens the focus to it', async () => {
      await inClusterA();
      await useStore.getState().goToLink('b/z.ts', 1);
      await useStore.getState().goToLink('a/y.ts', 1);
      expect(focusOf()).toEqual(A);
      useStore.getState().jumpBack();
      await vi.waitFor(() => expect(focusOf()).toEqual(B));
      const s = useStore.getState();
      expect(s.activePath).toBe('b/z.ts');
      expect(s.selection?.id).toBe(itemIdOf(s, 'b/z.ts'));
      expect(s.jumpIndex).toBe(0);
      expect(s.scrollTarget).toEqual(expect.objectContaining({ id: itemIdOf(s, 'b/z.ts') }));
    });

    it('Ctrl+o and Ctrl+i step over entries whose file is gone instead of stalling on them', async () => {
      await inClusterA();
      const at = (path: string) => ({ path, side: 'new' as const, line: 1 });
      useStore.setState({ jumps: [at('a/y.ts'), at('gone.ts'), at('b/z.ts')], jumpIndex: 3 });
      useStore.getState().jumpBack();
      await vi.waitFor(() => expect(useStore.getState().activePath).toBe('b/z.ts'));
      expect(useStore.getState().jumpIndex).toBe(2);
      useStore.getState().jumpBack();
      await vi.waitFor(() => expect(useStore.getState().activePath).toBe('a/y.ts'));
      expect(useStore.getState().jumpIndex).toBe(0);
      useStore.getState().jumpForward();
      await vi.waitFor(() => expect(useStore.getState().activePath).toBe('b/z.ts'));
      expect(useStore.getState().jumpIndex).toBe(2);
    });

    it('Ctrl+o does not advance the jumplist when no earlier entry is alive', async () => {
      await inClusterA();
      useStore.setState({ jumps: [{ path: 'gone.ts', side: 'new', line: 1 }], jumpIndex: 1 });
      useStore.getState().jumpBack();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(useStore.getState().jumpIndex).toBe(1);
      expect(useStore.getState().jumps).toEqual([{ path: 'gone.ts', side: 'new', line: 1 }]);
    });
  });

  describe('a graph that is out of date or never lands', () => {
    it('shows the changed files, not an empty review, when the focused cluster’s files are all gone', async () => {
      await open();
      await connect(graphOf(1));
      expect(focusedPaths()).toEqual(['a/x.ts', 'a/y.ts']);
      api.graph.mockReturnValueOnce(deferred<GraphResponse>().promise);
      const rest = FILES.slice(2);
      api.snapshot.mockResolvedValueOnce({
        ...snapshotAt(2),
        changed: rest.map((path) => file({ path, blob: `b-${path}` })),
      });
      await useStore.getState().refreshSnapshot();
      expect(useStore.getState().graph.data?.version).toBe(1);
      expect(focusedPaths()).toEqual(rest);
    });

    it('a transition that fails while the graph loads leaves the graph to land', async () => {
      await open();
      const answer = deferred<GraphResponse>();
      api.graph.mockReturnValueOnce(answer.promise);
      useStore.getState().setTreeScope('connected');
      api.reload.mockRejectedValueOnce(new Error('git is busy'));
      await useStore.getState().reload();
      expect(useStore.getState().toast).toBe('Reloading failed: git is busy');
      answer.resolve(graphOf(1));
      await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('ready'));
      expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'a/x.ts' });
    });

    it('a refresh while the graph loads takes the newer answer and drops the older one that lands late', async () => {
      await open();
      const stale = deferred<GraphResponse>();
      api.graph.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(graphOf(2));
      useStore.getState().setTreeScope('connected');
      api.snapshot.mockResolvedValueOnce(snapshotAt(2));
      await useStore.getState().refreshSnapshot();
      await vi.waitFor(() => expect(useStore.getState().graph.data?.version).toBe(2));
      stale.resolve(graphOf(1, [cluster('late.ts', ['a/x.ts'])]));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(useStore.getState().graph.data?.version).toBe(2);
      expect(useStore.getState().focus).toEqual({ kind: 'cluster', id: 'a/x.ts' });
      expect(api.graph).toHaveBeenCalledTimes(2);
    });

    it('a retry that a refresh starts fails quietly: the error shows on the graph, not as another toast', async () => {
      await open();
      api.graph.mockRejectedValueOnce(new Error('boom'));
      useStore.getState().setTreeScope('connected');
      await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('error'));
      expect(useStore.getState().toast).toBe('Loading the connected graph failed: boom');
      useStore.setState({ toast: null });

      api.graph.mockRejectedValueOnce(new Error('still boom'));
      api.snapshot.mockResolvedValueOnce(snapshotAt(2));
      await useStore.getState().refreshSnapshot();
      await vi.waitFor(() => expect(useStore.getState().graph.error).toBe('still boom'));
      expect(useStore.getState().graph.status).toBe('error');
      expect(useStore.getState().toast).toBeNull();
    });

    it('leaving Connected with the cursor on a caller moves the cursor to the first listed file and closes its draft', async () => {
      await open();
      api.file.mockImplementation(async (path: string) => ({ path, contents: 'one\ntwo\n', binary: false }));
      const g = graphOf(1);
      g.clusters[0] = {
        ...g.clusters[0]!,
        context: [{ path: 'ctx/u.ts', refs: 1, uses: [{ symbol: 'fx', kind: 12, path: 'src/lib.ts', lines: [2] }] }],
        contextTotal: 1,
      };
      api.snapshot.mockResolvedValueOnce({ ...snapshotAt(2), tree: [...FILES, 'ctx/u.ts'] });
      await useStore.getState().refreshSnapshot();
      await connect({ ...g, version: 2 });
      useStore.getState().toggleContext();
      await useStore.getState().openFile('ctx/u.ts');
      await useStore.getState().openDraft(useStore.getState().selection!);
      expect(useStore.getState().draft?.path).toBe('ctx/u.ts');

      useStore.getState().setTreeScope('changed');
      const s = useStore.getState();
      expect(s.activePath).toBe('a/x.ts');
      expect(s.draft).toBeNull();
      expect(s.selection?.id).not.toContain('ctx/u.ts');
    });
  });

  it('remembers the scope Connected was entered from, so gC returns there', async () => {
    await open();
    expect(useStore.getState().connectedFrom).toBe('changed');
    useStore.getState().setTreeScope('all');
    useStore.getState().setTreeScope('connected');
    expect(useStore.getState().connectedFrom).toBe('all');
    useStore.getState().setTreeScope('changed');
    useStore.getState().setTreeScope('connected');
    expect(useStore.getState().connectedFrom).toBe('changed');
    // Entering Connected again from Connected is not an entry.
    useStore.getState().setTreeScope('all');
    useStore.getState().setTreeScope('connected');
    useStore.getState().setTreeScope('connected');
    expect(useStore.getState().connectedFrom).toBe('all');
  });

  describe('context files', () => {
    const CTX_U = 'ctx/u.ts';
    const CTX_V = 'ctx/v.ts';
    const BODY = 'one\ntwo\nthree\nfour\nfive\n';
    const withContext = (version: number, key = 'working') => ({
      ...snapshotAt(version, key),
      tree: [...FILES, CTX_U, CTX_V, 'other/plain.ts'],
    });
    /** The first cluster has two callers: `u` uses it on lines 2 and 4, `v` on line 1. */
    const contextGraph = (version: number): GraphResponse => {
      const g = graphOf(version);
      g.clusters[0] = {
        ...g.clusters[0]!,
        context: [
          { path: CTX_U, refs: 3, uses: [{ symbol: 'fx', kind: 12, path: 'src/lib.ts', lines: [2, 4] }] },
          { path: CTX_V, refs: 1, uses: [{ symbol: 'fy', kind: 12, path: 'src/lib.ts', lines: [1] }] },
        ],
        contextTotal: 2,
      };
      return g;
    };
    const review = () => reviewPaths(useStore.getState());
    const loadedKind = (path: string) => useStore.getState().loaded[path]?.kind;
    // The changed files' own diffs read their sides through the same endpoint; only callers count here.
    const fetched = () => api.file.mock.calls.map((c) => c[0]).filter((p) => p.startsWith('ctx/'));

    async function enterConnected(version = 1) {
      api.patch.mockImplementation(async (p: string) => patchesFor([p]));
      api.patches.mockImplementation(async (paths: string[]) => patchesFor(paths));
      api.file.mockImplementation(async (path: string) => ({ path, contents: BODY, binary: false }));
      api.snapshot.mockResolvedValueOnce(withContext(version));
      await useStore.getState().refreshSnapshot();
      api.graph.mockResolvedValueOnce(contextGraph(version));
      useStore.getState().setTreeScope('connected');
      await vi.waitFor(() => expect(useStore.getState().graph.status).toBe('ready'));
    }

    it('lists the callers after the changed files only with context on and a cluster focused', async () => {
      await enterConnected();
      expect(review()).toEqual(['a/x.ts', 'a/y.ts']);
      useStore.getState().toggleContext();
      expect(review()).toEqual(['a/x.ts', 'a/y.ts', CTX_U, CTX_V]);
      // Viewed progress, patch loading and the global changed set stay about changed files.
      expect(listedPaths(useStore.getState())).toEqual(['a/x.ts', 'a/y.ts']);
      useStore.getState().moveCluster(1);
      expect(review()).toEqual(['b/w.ts', 'b/z.ts']);
      useStore.getState().moveCluster(1);
      expect(review()).toEqual(['c/solo.ts']);
      useStore.getState().toggleContext();
      expect(review()).toEqual(['c/solo.ts']);
    });

    it('starts every caller collapsed and fetches none until the reader expands one', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      expect(isCollapsed(useStore.getState(), CTX_U)).toBe(true);
      expect(isCollapsed(useStore.getState(), CTX_V)).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(fetched()).toEqual([]);
      expect(Object.keys(useStore.getState().loaded).filter((p) => p.startsWith('ctx/'))).toEqual([]);

      useStore.getState().toggleCollapsed(CTX_U);
      await vi.waitFor(() => expect(loadedKind(CTX_U)).toBe('file'));
      expect(api.file).toHaveBeenCalledWith(CTX_U, 'new', expect.anything());
      expect(fetched()).toEqual([CTX_U]);
      const s = useStore.getState();
      expect(s.gens[CTX_U]).toBeGreaterThan(0);
      expect(itemIdOf(s, CTX_U)).toBe(`file:${CTX_U}@${s.gens[CTX_U]}`);
      expect(s.contents[CTX_U]?.new).toBe(BODY);
    });

    it('zo on a collapsed caller loads it too', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      useStore.getState().moveFile('last');
      expect(useStore.getState().activePath).toBe(CTX_V);
      useStore.getState().setCollapsedAtCursor(false);
      await vi.waitFor(() => expect(loadedKind(CTX_V)).toBe('file'));
    });

    it('J / K walk from the last changed file onto the callers and back', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      const at = () => useStore.getState().activePath;
      useStore.getState().moveFile('first');
      useStore.getState().moveFile(1);
      expect(at()).toBe('a/y.ts');
      useStore.getState().moveFile(1);
      expect(at()).toBe(CTX_U);
      useStore.getState().moveFile(1);
      expect(at()).toBe(CTX_V);
      useStore.getState().moveFile(1);
      expect(at()).toBe(CTX_V);
      useStore.getState().moveFile(-1);
      useStore.getState().moveFile(-1);
      expect(at()).toBe('a/y.ts');
    });

    it('drops a late file when the focus changed meanwhile', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      const slow = deferred<{ path: string; contents: string; binary: boolean }>();
      api.file.mockReturnValueOnce(slow.promise);
      useStore.getState().toggleCollapsed(CTX_U);
      useStore.getState().moveCluster(1);
      slow.resolve({ path: CTX_U, contents: BODY, binary: false });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(loadedKind(CTX_U)).toBeUndefined();
      expect(review()).toEqual(['b/w.ts', 'b/z.ts']);
    });

    it('drops a late file when context was switched off meanwhile', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      const slow = deferred<{ path: string; contents: string; binary: boolean }>();
      api.file.mockReturnValueOnce(slow.promise);
      useStore.getState().toggleCollapsed(CTX_U);
      useStore.getState().toggleContext();
      slow.resolve({ path: CTX_U, contents: BODY, binary: false });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(loadedKind(CTX_U)).toBeUndefined();
    });

    it('turning context off, or focusing another group, removes the loaded callers', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      useStore.getState().toggleCollapsed(CTX_U);
      await vi.waitFor(() => expect(loadedKind(CTX_U)).toBe('file'));
      useStore.getState().toggleContext();
      expect(loadedKind(CTX_U)).toBeUndefined();
      expect(review()).toEqual(['a/x.ts', 'a/y.ts']);

      // Opened by the reader, so it comes back open and fetches again.
      useStore.getState().toggleContext();
      await vi.waitFor(() => expect(loadedKind(CTX_U)).toBe('file'));
      useStore.getState().moveCluster(1);
      expect(loadedKind(CTX_U)).toBeUndefined();
    });

    describe('across a refresh', () => {
      /** Context on, `ctx/u.ts` open with the cursor on its first linking line and a comment started there. */
      async function readingCaller() {
        await enterConnected();
        useStore.getState().toggleContext();
        await useStore.getState().openFile(CTX_U);
        await useStore.getState().openDraft(useStore.getState().selection!);
        return useStore.getState();
      }

      it('a version bump leaves the open caller, its cursor and its draft where they are while the new graph loads', async () => {
        const before = await readingCaller();
        const item = before.loaded[CTX_U];
        const fetches = api.file.mock.calls.length;

        api.graph.mockReturnValueOnce(deferred<GraphResponse>().promise);
        api.snapshot.mockResolvedValueOnce(withContext(2));
        await useStore.getState().refreshSnapshot();

        const s = useStore.getState();
        expect(review()).toEqual(['a/x.ts', 'a/y.ts', CTX_U, CTX_V]);
        expect(s.loaded[CTX_U]).toBe(item);
        expect(itemIdOf(s, CTX_U)).toBe(itemIdOf(before, CTX_U));
        expect(s.selection).toEqual(before.selection);
        expect(s.activePath).toBe(CTX_U);
        expect(s.draft).toEqual(before.draft);
        expect(s.scrollTarget).toBe(before.scrollTarget);
        expect(api.file.mock.calls.length).toBe(fetches);
      });

      it('the new graph that still lists the caller changes nothing for the reader', async () => {
        const before = await readingCaller();
        const item = before.loaded[CTX_U];
        const answer = deferred<GraphResponse>();
        api.graph.mockReturnValueOnce(answer.promise);
        api.snapshot.mockResolvedValueOnce(withContext(2));
        await useStore.getState().refreshSnapshot();

        answer.resolve(contextGraph(2));
        await vi.waitFor(() => expect(useStore.getState().graph.data?.version).toBe(2));
        const s = useStore.getState();
        expect(s.loaded[CTX_U]).toBe(item);
        expect(itemIdOf(s, CTX_U)).toBe(itemIdOf(before, CTX_U));
        expect(s.selection).toEqual(before.selection);
        expect(s.draft).toEqual(before.draft);
        expect(s.scrollTarget).toBe(before.scrollTarget);
        expect(review()).toEqual(['a/x.ts', 'a/y.ts', CTX_U, CTX_V]);
      });

      it('a new graph that no longer lists the caller prunes it, moves the cursor to the first listed file and closes the draft', async () => {
        await readingCaller();
        const answer = deferred<GraphResponse>();
        api.graph.mockReturnValueOnce(answer.promise);
        api.snapshot.mockResolvedValueOnce(withContext(2));
        await useStore.getState().refreshSnapshot();
        expect(loadedKind(CTX_U)).toBe('file');

        answer.resolve(graphOf(2));
        await vi.waitFor(() => expect(loadedKind(CTX_U)).toBeUndefined());
        const s = useStore.getState();
        expect(review()).toEqual(['a/x.ts', 'a/y.ts']);
        expect(s.activePath).toBe('a/x.ts');
        expect(s.draft).toBeNull();
      });

      it('fetches an open caller again when a side of the review moved, since its text may differ', async () => {
        await readingCaller();
        expect(fetched()).toEqual([CTX_U]);
        api.graph.mockResolvedValueOnce(contextGraph(2));
        api.snapshot.mockResolvedValueOnce({ ...withContext(2), oldSha: 'moved' });
        await useStore.getState().refreshSnapshot();
        await vi.waitFor(() => expect(fetched()).toEqual([CTX_U, CTX_U]));
        await vi.waitFor(() => expect(loadedKind(CTX_U)).toBe('file'));
      });

      it('drops a caller from the pane the moment it becomes a changed file, and never lists it twice', async () => {
        await readingCaller();
        const patch = deferred<string>();
        api.patch.mockReturnValueOnce(patch.promise);
        api.graph.mockReturnValueOnce(deferred<GraphResponse>().promise);
        const now = withContext(2);
        api.snapshot.mockResolvedValueOnce({
          ...now,
          changed: [...now.changed, file({ path: CTX_U, blob: 'new' })],
        });
        const refreshed = useStore.getState().refreshSnapshot();
        await vi.waitFor(() => expect(useStore.getState().snapshot?.version).toBe(2));
        expect(loadedKind(CTX_U)).toBeUndefined();
        expect(review()).toEqual(['a/x.ts', 'a/y.ts', CTX_V]);
        patch.resolve(patchesFor([CTX_U]));
        await refreshed;
      });

      it('keeps a draft on a caller across a refresh, and discards one on a file that left the review', async () => {
        const before = await readingCaller();
        api.graph.mockReturnValueOnce(deferred<GraphResponse>().promise);
        api.snapshot.mockResolvedValueOnce(withContext(2));
        await useStore.getState().refreshSnapshot();
        expect(useStore.getState().draft).toEqual(before.draft);

        useStore.getState().toggleContext();
        expect(useStore.getState().draft).toBeNull();
      });

      it('a mode switch while a caller is loading drops its text', async () => {
        await enterConnected();
        useStore.getState().toggleContext();
        const slow = deferred<{ path: string; contents: string; binary: boolean }>();
        api.file.mockReturnValueOnce(slow.promise);
        useStore.getState().toggleCollapsed(CTX_U);
        api.graph.mockReturnValueOnce(deferred<GraphResponse>().promise);
        api.enter.mockResolvedValueOnce(withContext(2, 'pr:abc'));
        await useStore.getState().enter({ kind: 'pr' });
        slow.resolve({ path: CTX_U, contents: BODY, binary: false });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(loadedKind(CTX_U)).toBeUndefined();
      });
    });

    describe('zO and zC', () => {
      it('open and close the listed callers too, loading each one that opens', async () => {
        await enterConnected();
        useStore.getState().toggleContext();
        useStore.getState().setAllCollapsed(false);
        await vi.waitFor(() => expect(fetched().sort()).toEqual([CTX_U, CTX_V]));
        await vi.waitFor(() => expect(loadedKind(CTX_V)).toBe('file'));
        expect(isCollapsed(useStore.getState(), CTX_U)).toBe(false);
        expect(isCollapsed(useStore.getState(), 'a/x.ts')).toBe(false);

        useStore.getState().setAllCollapsed(true);
        expect(isCollapsed(useStore.getState(), CTX_U)).toBe(true);
        expect(isCollapsed(useStore.getState(), CTX_V)).toBe(true);
        expect(isCollapsed(useStore.getState(), 'a/y.ts')).toBe(true);
      });

      it('leave the explicit state of files outside the list alone', async () => {
        await enterConnected();
        useStore.getState().toggleCollapsed('b/z.ts');
        expect(isCollapsed(useStore.getState(), 'b/z.ts')).toBe(true);
        useStore.getState().setAllCollapsed(false);
        expect(isCollapsed(useStore.getState(), 'b/z.ts')).toBe(true);
        expect(isCollapsed(useStore.getState(), 'a/x.ts')).toBe(false);
      });
    });

    it('a mode switch removes the callers with everything else loaded', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      useStore.getState().toggleCollapsed(CTX_U);
      await vi.waitFor(() => expect(loadedKind(CTX_U)).toBe('file'));
      api.graph.mockReturnValueOnce(deferred<GraphResponse>().promise);
      api.enter.mockResolvedValueOnce(withContext(2, 'pr:abc'));
      await useStore.getState().enter({ kind: 'pr' });
      expect(loadedKind(CTX_U)).toBeUndefined();
      expect(review()).not.toContain(CTX_U);
    });

    it('leaving Connected removes the callers', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      useStore.getState().toggleCollapsed(CTX_U);
      await vi.waitFor(() => expect(loadedKind(CTX_U)).toBe('file'));
      useStore.getState().setTreeScope('changed');
      expect(loadedKind(CTX_U)).toBeUndefined();
      expect(review()).toEqual(FILES);
    });

    it('moves the cursor to the first listed file when its caller leaves the list', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      useStore.getState().moveFile('last');
      expect(useStore.getState().activePath).toBe(CTX_V);
      useStore.getState().toggleContext();
      expect(useStore.getState().activePath).toBe('a/x.ts');

      useStore.getState().toggleContext();
      useStore.getState().moveFile('last');
      useStore.getState().moveCluster(1);
      expect(useStore.getState().activePath).toBe('b/w.ts');
    });

    it('openFile on a caller reveals it: expanded, loaded, the cursor on its first linking line at the gaze point', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      await useStore.getState().openFile(CTX_U);
      const s = useStore.getState();
      expect(s.fileView).toBeNull();
      expect(isCollapsed(s, CTX_U)).toBe(false);
      expect(s.loaded[CTX_U]?.kind).toBe('file');
      expect(s.activePath).toBe(CTX_U);
      expect(s.selection).toEqual({
        id: itemIdOf(s, CTX_U),
        range: { start: 2, side: 'additions', end: 2, endSide: 'additions' },
      });
      expect(s.scrollTarget).toEqual(expect.objectContaining({ id: itemIdOf(s, CTX_U), line: 2, align: 'eye' }));
    });

    it('openFile on a caller leaves an open file view for the list', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      await useStore.getState().openFile('other/plain.ts');
      expect(useStore.getState().fileView?.path).toBe('other/plain.ts');
      await useStore.getState().openFile(CTX_V);
      expect(useStore.getState().fileView).toBeNull();
      expect(useStore.getState().activePath).toBe(CTX_V);
    });

    it('openFile opens the file view for any other unchanged path, and for a caller while context is off', async () => {
      await enterConnected();
      await useStore.getState().openFile('other/plain.ts');
      expect(useStore.getState().fileView?.path).toBe('other/plain.ts');
      useStore.getState().closeFullFile();
      await useStore.getState().openFile(CTX_U);
      expect(useStore.getState().fileView?.path).toBe(CTX_U);
      expect(useStore.getState().loaded[CTX_U]).toBeUndefined();
    });

    it('] / [ stop on the linking lines of an open caller, at the gaze point', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      await useStore.getState().openFile(CTX_U);
      const line = () => useStore.getState().selection?.range.end;
      expect(line()).toBe(2);
      useStore.getState().moveHunk(1);
      expect(line()).toBe(4);
      expect(useStore.getState().scrollTarget).toEqual(expect.objectContaining({ line: 4, align: 'eye' }));
      useStore.getState().moveHunk(-1);
      expect(line()).toBe(2);
    });

    it('counts no caller in viewed progress and marks none viewed', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      useStore.getState().toggleCollapsed(CTX_U);
      await vi.waitFor(() => expect(loadedKind(CTX_U)).toBe('file'));
      api.setViewed.mockResolvedValue([]);
      // The server answers with the marks it now holds.
      api.setViewedBulk.mockImplementation(async (entries: unknown[]) => entries);
      const before = countViewed(useStore.getState(), useStore.getState().snapshot!.changed);

      await useStore.getState().setViewed(CTX_U, true);
      useStore.setState({ activePath: CTX_U });
      await useStore.getState().toggleViewedAtCursor();
      await useStore.getState().setViewedMany([...FILES, CTX_U], true);

      expect(api.setViewed).not.toHaveBeenCalled();
      expect(api.setViewedBulk.mock.calls[0]![0].map((e: { path: string }) => e.path)).toEqual(FILES);
      expect(useStore.getState().viewed.some((v) => v.path === CTX_U)).toBe(false);
      expect(before).toBe(0);
      expect(countViewed(useStore.getState(), useStore.getState().snapshot!.changed)).toBe(FILES.length);
    });

    it('lets the reader comment on a caller without touching changed-file state', async () => {
      await enterConnected();
      useStore.getState().toggleContext();
      await useStore.getState().openFile(CTX_U);
      const sel = useStore.getState().selection!;
      await useStore.getState().openDraft(sel);
      expect(useStore.getState().draft).toEqual({ path: CTX_U, selection: sel });
      useStore.getState().openFileDraft(CTX_V);
      expect(useStore.getState().draft).toEqual({ path: CTX_V, selection: null });
    });
  });
});
