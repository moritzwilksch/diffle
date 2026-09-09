import type { CodeViewLineSelection, FileContents, FileDiffMetadata } from '@pierre/diffs';
import { hydratePartialDiff, parsePatchFiles } from '@pierre/diffs';
import type { FileTree } from '@pierre/trees';
import { create } from 'zustand';
import {
  DEFAULT_USER_CONFIG,
  followsCheckout,
  lspBlocker,
  type ChangedFile,
  type CommentThread,
  type FileResponse,
  type LspLocationsResponse,
  type LspPosition,
  type LspStatus,
  type LspSymbol,
  type ModeRequest,
  type SearchMatch,
  type SearchScope,
  type Side,
  type Snapshot,
  type UserConfig,
  type ViewedEntry,
} from '../shared/protocol.js';
import { api } from './api.js';
import { anchorFromRange, resolveRange, sideOf } from './comments/anchor.js';
import {
  buildNav,
  cursorFromSelection,
  selectionFor,
  step,
  stepFile,
  stepHunk,
  type Cursor,
  type LineRange,
  type NavItem,
} from './keyboard/nav.js';
import { lspTarget, type TokenTarget } from './lsp/target.js';
import type { ExportOutcome } from './model.js';
import {
  currentPath,
  filterSymbols,
  isCollapsed,
  isViewed,
  itemIdOf,
  lastCommitsRequest,
  linesOf,
  OVERSIZED_LINES,
  patchBatches,
  pathFromItemId,
  reuseThreads,
  visibleThreads,
} from './model.js';
import { applyTheme, readTheme, storeTheme, type ThemeChoice } from './theme.js';

export type Loaded =
  | { kind: 'diff'; fileDiff: FileDiffMetadata }
  | { kind: 'file'; file: FileContents }
  | { kind: 'binary' }
  /** A diff too large to load unasked (see OVERSIZED_LINES); `loadPatch` fetches it. */
  | { kind: 'oversized'; lines: number }
  | { kind: 'error'; message: string }
  /** Not fetched yet: the review pane's header-only placeholder. The store never records this kind. */
  | { kind: 'loading' };

export interface Draft {
  path: string;
  selection: CodeViewLineSelection;
}

export type DiffStyle = 'split' | 'unified';
const DIFF_STYLE_KEY = 'diffle:diffStyle';
/** Typing pause before a workspace symbol query goes to the server. */
export const WORKSPACE_SYMBOL_DEBOUNCE_MS = 150;
/** How long every toast stays visible: long enough to read a full sentence, since errors are the main thing shown. */
export const TOAST_MS = 3500;
function readDiffStyle(): DiffStyle {
  try {
    return localStorage.getItem(DIFF_STYLE_KEY) === 'unified' ? 'unified' : 'split';
  } catch {
    return 'split';
  }
}

export interface SearchState {
  open: boolean;
  /** What the matches are: a text search, the references of `query`, or whole-word occurrences of it (* / #). */
  kind: 'text' | 'references' | 'word';
  /** Which way `n` walks the matches: -1 after `#`, as in vim. */
  direction: 1 | -1;
  /** Text-search options; `*` / `#` ignore them (whole word, case-sensitive, whole repository). */
  ignoreCase: boolean;
  regex: boolean;
  /** 'file' searches the file the reader is in; 'diff' only the changed files; 'repo' the whole codebase. */
  scope: SearchScope;
  /** The file a 'file'-scoped result set came from; the bar names it while the query has run. */
  path: string | null;
  /** Bumped by `g/` so the box takes focus again after `n` / `N` blurred it. */
  focusNonce: number;
  query: string;
  matches: SearchMatch[];
  index: number;
  loading: boolean;
  truncated: boolean;
}

export interface LayoutState {
  /** Pane widths in px once the user has dragged a resizer; null leaves the stylesheet's rem default in charge. */
  treeWidth: number | null;
  panelWidth: number | null;
  treeVisible: boolean;
  panelVisible: boolean;
}
const LAYOUT_KEY = 'diffle:layout';
const DEFAULT_LAYOUT: LayoutState = { treeWidth: null, panelWidth: null, treeVisible: true, panelVisible: true };
function readLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutState>) } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Small action popover anchored at a clicked symbol. */
export interface SymbolMenuState {
  target: TokenTarget;
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
}

/** Editor-style tooltip with what the language server knows about the hovered symbol. */
export interface HoverState {
  target: TokenTarget;
  /** Markdown from the server. */
  contents: string;
  /** Viewport box of the hovered token; the tooltip hangs below it, or above near the bottom edge. */
  anchor: { left: number; top: number; bottom: number };
}

/** Full-screen list of a symbol's references; Enter jumps to the highlighted one. */
export interface ReferencesState {
  open: boolean;
  /** References of `symbol`, or the candidate types a type-definition query returned for it. */
  kind: 'references' | 'types';
  symbol: string;
  items: SearchMatch[];
  index: number;
}

export interface SymbolsState {
  open: boolean;
  scope: 'document' | 'workspace';
  /** Document scope: the file whose symbols are listed. */
  path: string | null;
  query: string;
  /** Document scope: every symbol; `items` is the filtered view. */
  all: LspSymbol[];
  items: LspSymbol[];
  index: number;
  loading: boolean;
}

export interface JumpPosition {
  path: string;
  side: Side;
  line: number;
  /** The position sits in the file view of `path`, not in the diff list. */
  full?: boolean;
}

/**
 * The dedicated whole-file view: one path's new side in place of the diff list. `item` is
 * null while it loads. `from` is where the diff list was left, so leaving the view restores it.
 */
export interface FileView {
  path: string;
  item: Loaded | null;
  from: { position: JumpPosition | null; activePath: string | null };
}

export interface ReviewState {
  layout: LayoutState;
  setLayout(patch: Partial<LayoutState>): void;
  diffStyle: DiffStyle;
  setDiffStyle(style: DiffStyle): void;
  theme: ThemeChoice;
  setTheme(theme: ThemeChoice): void;

  // Keyboard navigation and transient UI state.
  /** Anchor row while in visual (block) mode. */
  visualAnchor: Cursor | null;
  /** Message being edited inline. */
  editingId: string | null;
  setEditingId(id: string | null): void;
  /** Thread whose reply composer is open. Exclusive with `draft`. */
  replyTo: string | null;
  openReply(threadId: string): void;
  /** Thread the user jumped to from the panel; its in-diff card is outlined until the next selection or jump. */
  focusedThread: string | null;
  focusThread(threadId: string | null): void;
  closeReply(): void;
  modeMenuOpen: boolean;
  setModeMenuOpen(open: boolean): void;
  /** Set by `m 5`: the picker should expand its two-refs form. */
  twoRefsOpen: boolean;
  setTwoRefsOpen(open: boolean): void;
  /** N for the "Last N commits" entry (HEAD~N..HEAD); shortcut 4 reuses it. */
  lastCommits: number;
  setLastCommits(n: number): void;
  pickModeEntry(n: number): void;
  helpOpen: boolean;
  setHelpOpen(open: boolean): void;
  treeModel: FileTree | null;
  setTreeModel(model: FileTree | null): void;
  toast: string | null;
  flash(message: string): void;
  /** Toast for a failed fire-and-forget action: `${what} failed: <message>`. */
  report(what: string, e: unknown): void;
  search: SearchState;
  /** Open the text search box; `scope` replaces the remembered scope (`/` → file, `g/` → widened). */
  openSearch(scope?: SearchScope): void;
  closeSearch(): void;
  runSearch(query: string): Promise<void>;
  /** Flip a text-search option and rerun the current query. */
  setSearchOptions(opts: Partial<Pick<SearchState, 'ignoreCase' | 'regex' | 'scope'>>): void;
  moveMatch(delta: 1 | -1): void;
  /** `*` / `#`: whole-word search for the focused word, landing on the next occurrence in `delta`'s direction. */
  searchWord(delta: 1 | -1): Promise<void>;
  lsp: LspStatus;
  setLspStatus(status: LspStatus): void;
  symbolMenu: SymbolMenuState | null;
  /** Opens the popover; not at all with `--no-lsp`, and not on a token the server classifies as a keyword. */
  openSymbolMenu(target: TokenTarget, x: number, y: number): Promise<void>;
  closeSymbolMenu(): void;
  hover: HoverState | null;
  /**
   * Ask the server about the hovered `target` and show the answer at `anchor`. Silent when the
   * server is off, the token is not queryable, or the symbol menu is open; a later request or
   * `closeHover` drops the answer of an earlier one.
   */
  requestHover(target: TokenTarget, anchor: HoverState['anchor']): Promise<void>;
  /** Open the tooltip for the focused, else hovered, token (gh). Flashes when nothing applies. */
  showHover(): Promise<void>;
  closeHover(): void;
  /** Jump to the definition of `target` (default: the clicked, else the hovered token). Flashes when nothing applies. */
  goToDefinition(target?: TokenTarget | null): Promise<void>;
  /** Jump to where the type of the symbol is defined (gy). */
  goToTypeDefinition(target?: TokenTarget | null): Promise<void>;
  /** Follow a `diffle:` link in rendered markdown (the hover text's "Go to X") to `path` at `line`, as gd lands. */
  goToLink(path: string, line?: number): Promise<void>;
  /** List the references of `target` in the references overlay. */
  findReferences(target?: TokenTarget | null): Promise<void>;
  references: ReferencesState;
  moveReference(delta: 1 | -1): void;
  /** Jump to the highlighted reference; the list stays available to n / N afterwards. */
  pickReference(): void;
  closeReferences(): void;
  symbols: SymbolsState;
  /** document: symbols of the active file; workspace: symbols matching the typed query. */
  openSymbols(scope: 'document' | 'workspace'): Promise<void>;
  querySymbols(query: string): Promise<void>;
  moveSymbol(delta: 1 | -1): void;
  pickSymbol(): void;
  closeSymbols(): void;
  /** Vim-style jump list: positions left behind by hunk/file/search/panel jumps. */
  jumps: JumpPosition[];
  jumpIndex: number;
  jumpBack(): void;
  jumpForward(): void;
  moveCursor(delta: 1 | -1): void;
  /** Move by many rows (Ctrl+d / Ctrl+u), keeping the cursor at eye level. */
  moveCursorBy(rows: number): void;
  /** Scroll so the cursor line sits near the top or bottom of the view (zt / zb) or on the gaze point (zz); the cursor itself stays put. */
  scrollCursorTo(edge: 'top' | 'bottom' | 'eye'): void;
  moveFile(delta: 1 | -1 | 'first' | 'last'): void;
  /** `{n}gg` / `{n}G`: put the cursor on new-side line `line` of the current file, expanding context if needed. */
  goToLine(line: number): Promise<void>;
  moveHunk(delta: 1 | -1): void;
  toggleVisual(): void;
  /** Edit the newest message of the thread under the cursor. */
  editCommentAtCursor(): void;
  /** Delete the thread under the cursor. */
  deleteCommentAtCursor(): Promise<void>;
  /** Flip resolved on the thread under the cursor. */
  toggleResolvedAtCursor(): Promise<void>;
  toggleViewedAtCursor(): Promise<void>;
  /** Open the next (or previous) unviewed file in risk order (see review/order.ts). */
  setCollapsedAtCursor(collapsed: boolean): void;
  setAllCollapsed(collapsed: boolean): void;
  escape(): void;
  snapshot: Snapshot | null;
  error: string | null;
  threads: CommentThread[];
  /** Resolved threads stay hidden unless the user turns them on. */
  showResolved: boolean;
  setShowResolved(on: boolean): void;
  viewed: ViewedEntry[];
  config: UserConfig;
  /** Open while the main pane shows one whole file instead of the diff list. */
  fileView: FileView | null;
  loaded: Record<string, Loaded>;
  /**
   * Per-path content generation. Part of the CodeView item id, so a reloaded
   * diff gets a fresh renderer instead of being patched into a stale one.
   */
  gens: Record<string, number>;
  contents: Record<string, { old?: string; new?: string }>;
  collapsed: Record<string, boolean>;
  selection: CodeViewLineSelection | null;
  draft: Draft | null;
  activePath: string | null;
  /** Ask the viewer to expand collapsed context so `line` (new side) is rendered, then center it. */
  reveal: { id: string; path: string; line: number; nonce: number } | null;
  /** Context lines the viewer has expanded, by item id, so the cursor can walk them. */
  revealed: Record<string, LineRange[]>;
  addRevealed(id: string, start: number, end: number): void;
  /** Bumped when the user wants CodeView to scroll to `scrollTarget`. */
  /** align 'eye' pins the line at the vertical center of the viewport for jump navigation. */
  /** 'top' / 'bottom' pin the line near the edges of the viewport (zt / zb), the same way 'eye' pins it at the gaze point. */
  scrollTarget: {
    id: string;
    line?: number;
    side?: Side;
    align?: 'start' | 'center' | 'nearest' | 'eye' | 'top' | 'bottom';
    nonce: number;
  } | null;

  /** Fetches everything unconditionally: the first load, and the resync after the socket reconnects. */
  boot(): Promise<void>;
  /** Refetch the snapshot, threads and viewed marks. A push names the `version` it announces; one the client holds or is fetching is ignored. */
  refreshSnapshot(version?: number): Promise<void>;
  refreshThreads(): Promise<void>;
  refreshViewed(): Promise<void>;
  refreshConfig(): Promise<void>;
  switchMode(req: ModeRequest): Promise<void>;
  /** Jumps to a line of a path: in its diff for a changed file, else in the file view of that file. */
  openFile(path: string, line?: number, side?: Side): Promise<void>;
  /** Full contents of one side, one request per side and path per transition, shared with hydration and the file view. */
  loadFile(path: string, side: Side): Promise<FileResponse>;
  /** Fetch the diff of a file that loaded as oversized. No-op for anything else. */
  loadPatch(path: string): Promise<void>;
  /** Show a path's whole new side in the file view, with the cursor on `line` or the top. No-op for deleted files. */
  openFullFile(path: string, line?: number): Promise<void>;
  /** Back to the diff list, at the position the file view was entered from. */
  closeFullFile(): void;
  setSelection(sel: CodeViewLineSelection | null): void;
  openDraft(sel: CodeViewLineSelection): Promise<void>;
  closeDraft(): void;
  /** The text the current draft would quote; feeds the "suggest change" button. */
  draftQuote(): Promise<string>;
  submitDraft(body: string): Promise<void>;
  submitReply(threadId: string, body: string): Promise<void>;
  editMessage(threadId: string, messageId: string, body: string): Promise<void>;
  deleteMessage(threadId: string, messageId: string): Promise<void>;
  setResolved(threadId: string, resolved: boolean): Promise<void>;
  deleteThread(id: string): Promise<void>;
  clearThreads(): Promise<void>;
  deleteStaleThreads(): Promise<void>;
  /** Adds threads to a pending review on the branch's GitHub pull request; the human submits the review on GitHub. A toast appears only when threads are skipped or the post fails. */
  /** Post open threads (or the given ones) to the PR; resolves to what happened, or null when the post failed. */
  exportToGithub(threadIds?: string[]): Promise<ExportOutcome | null>;
  setViewed(path: string, viewed: boolean): Promise<void>;
  /** Mark every changed file not viewed (explicit marks override auto-viewed globs) and expand them. */
  unviewAll(): Promise<void>;
  toggleCollapsed(path: string): void;
  saveConfig(config: Partial<Pick<UserConfig, 'autoViewed' | 'contextLines'>>): Promise<void>;
  jumpTo(path: string, line?: number, side?: Side): void;
  setActivePath(path: string | null): void;
}

export const useStore = create<ReviewState>((set, get) => {
  /**
   * One token per client transition (boot, refresh, mode switch). Results of a
   * transition commit only while its token is still current, so a slow response
   * can never overwrite state from a newer transition.
   */
  let generation = 0;
  const current = (g: number) => g === generation;
  /** Bumped by every symbol menu open and close, so a stale token-kind answer cannot open a menu the user already dismissed. */
  let menuSeq = 0;
  /** Hover requests, newest wins: moving across tokens must not show an earlier token's answer. */
  let hoverSeq = 0;
  /** The typing pause a workspace symbol query is waiting out; a newer query ends it early. */
  let symbolWait: { timer: ReturnType<typeof setTimeout>; wake: () => void } | null = null;
  const cancelSymbolWait = () => {
    if (!symbolWait) return;
    clearTimeout(symbolWait.timer);
    symbolWait.wake();
    symbolWait = null;
  };
  /** Aborts every full-file request of the current transition; replaced by `begin`. */
  let aborter = new AbortController();
  /**
   * Full-file loads of the current transition, in flight or finished, keyed by side and path.
   * Hydration, the file view, comment anchors and the viewer's context expansion all read
   * through it, so concurrent consumers share one request. A rejected load is dropped so the
   * next consumer retries; the map is cleared with its transition.
   */
  const loads = new Map<string, Promise<FileResponse>>();
  const begin = () => {
    aborter.abort();
    aborter = new AbortController();
    loads.clear();
    return ++generation;
  };
  /**
   * Counts boots and mode switches. Viewed marks are per mode, so a mark persisted in one mode
   * must not land after another mode took over; a watcher refresh keeps the mode and the marks.
   */
  let modeGeneration = 0;
  const beginMode = () => {
    modeGeneration++;
    return begin();
  };
  /**
   * One sequence per resource whose requests may return out of order (search, threads, viewed,
   * config): only the newest request started may commit, whether it succeeds or fails.
   */
  const sequence = () => {
    let n = 0;
    return { start: () => ++n, latest: (t: number) => t === n };
  };
  const searchSeq = sequence();
  const threadsSeq = sequence();
  const viewedSeq = sequence();
  const configSeq = sequence();
  /** Runs writes one after another: the server applies same-key mutations in the order the user made them. */
  const serial = () => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
      const next = tail.then(fn);
      tail = next.catch(() => {});
      return next;
    };
  };
  const viewedWrites = serial();
  const configWrites = serial();
  /**
   * Version of the snapshot a refresh is fetching right now, 0 when none. The server broadcasts
   * a new version before the request that produced it returns, so both the push and the response
   * would otherwise start a fetch; whichever arrives second sees the version already accounted for.
   */
  let fetching = 0;
  /**
   * True from a boot until the next snapshot commits. Versions restart with the server, so a
   * push while a reconnect resyncs must not be judged against the previous lifetime's count.
   */
  let resyncing = false;
  const accounted = (version: number) =>
    version <= fetching || (!resyncing && version <= (get().snapshot?.version ?? 0));
  /** Threads and viewed marks for a transition, numbered so a refresh started later in the same generation wins. */
  const fetchLists = () => {
    const tt = threadsSeq.start();
    const tv = viewedSeq.start();
    return Promise.all([api.threads(), api.viewed()]).then(([threads, viewed]) => ({ threads, viewed, tt, tv }));
  };
  type Lists = Awaited<ReturnType<typeof fetchLists>>;
  /** Commits one transition's threads, viewed marks and snapshot, unless a newer transition began. */
  const commitSnapshot = async (snap: Snapshot, g: number, lists: Lists) => {
    if (!current(g)) return;
    if (viewedSeq.latest(lists.tv)) set({ viewed: lists.viewed });
    if (threadsSeq.latest(lists.tt)) acceptThreads(lists.threads);
    await applySnapshot(snap, g);
  };
  /** One side of a file in the current transition; rejects with an AbortError once a newer transition begins. */
  const fetchFile = (path: string, side: Side): Promise<FileResponse> => {
    const key = `${generation}\0${side}\0${path}`;
    let p = loads.get(key);
    if (!p) {
      p = api.file(path, side, aborter.signal);
      loads.set(key, p);
      p.catch(() => loads.delete(key));
    }
    return p;
  };
  const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';
  /** `fetchFile` for consumers that outlive transitions: a load the transition aborted is retried in the new one. */
  const loadFile = async (path: string, side: Side): Promise<FileResponse> => {
    for (;;) {
      try {
        return await fetchFile(path, side);
      } catch (e) {
        if (!isAbort(e)) throw e;
      }
    }
  };

  const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** Failures of fire-and-forget actions surface as a toast instead of an unhandled rejection. */
  const report = (what: string, e: unknown) => get().flash(`${what} failed: ${errorMessage(e)}`);

  /** Contents of one side of a file, cached per transition: a late response never seeds the next mode's cache. */
  const ensureContents = async (path: string, side: Side): Promise<string> => {
    const have = get().contents[path]?.[side];
    if (have != null) return have;
    const g = generation;
    const res = await loadFile(path, side);
    if (current(g))
      set((s) => ({ contents: { ...s.contents, [path]: { ...s.contents[path], [side]: res.contents } } }));
    return res.contents;
  };

  /**
   * New content generation for `paths`: the item ids change, so the selection
   * and the draft move to the new ids and the cursor survives the reload.
   */
  const regen = (
    s: ReviewState,
    paths: string[],
  ): Pick<ReviewState, 'gens' | 'selection' | 'draft' | 'scrollTarget' | 'reveal'> => {
    const gens = { ...s.gens };
    for (const p of paths) gens[p] = (gens[p] ?? 0) + 1;
    const moved = <T extends { id: string }>(x: T): T => {
      const path = pathFromItemId(x.id);
      return paths.includes(path)
        ? { ...x, id: itemIdOf({ snapshot: s.snapshot, gens, fileView: s.fileView }, path) }
        : x;
    };
    return {
      gens,
      selection: s.selection && moved(s.selection),
      draft: s.draft && { ...s.draft, selection: moved(s.draft.selection) },
      // A new object re-runs the scroll effect, so a jump in flight lands on the fresh renderer.
      scrollTarget: s.scrollTarget && moved(s.scrollTarget),
      reveal: s.reveal && moved(s.reveal),
    };
  };

  /**
   * Loads the patches of `paths` in bounded batches, the file the reader is on first (see
   * `patchBatches`), each batch committing as it lands so the first diff paints before the
   * rest downloads. Binary files and oversized diffs commit at once without a request.
   */
  const loadPatches = async (snap: Snapshot, paths: string[], g: number) => {
    const byPath = new Map(snap.changed.map((f) => [f.path, f]));
    const wanted = paths.filter((p) => byPath.has(p));
    if (wanted.length === 0) return;
    const immediate: Record<string, Loaded> = {};
    const textual: ChangedFile[] = [];
    const prev = get().loaded;
    for (const p of wanted) {
      const f = byPath.get(p)!;
      if (f.binary) immediate[p] = { kind: 'binary' };
      // A diff already on screen is refreshed in place whatever its size; only an unloaded one waits to be asked for.
      else if (linesOf(f) > OVERSIZED_LINES && prev[p]?.kind !== 'diff')
        immediate[p] = { kind: 'oversized', lines: linesOf(f) };
      else textual.push(f);
    }
    if (Object.keys(immediate).length > 0)
      set((s) => ({ loaded: { ...s.loaded, ...immediate }, ...regen(s, Object.keys(immediate)) }));
    const s = get();
    const first = [s.fileView?.path, s.activePath, s.selection && pathFromItemId(s.selection.id)].filter(
      (p): p is string => p != null,
    );
    const batches = patchBatches(snap, textual, first, (p) => isCollapsed(s, p));
    await mapLimit(
      batches,
      2,
      () => !current(g),
      (batch) => loadBatch(snap, batch, g),
    );
  };

  /** One patch request for `paths` (non-binary changed files), committed on arrival and queued for hydration. */
  const loadBatch = async (snap: Snapshot, paths: string[], g: number) => {
    const byPath = new Map(snap.changed.map((f) => [f.path, f]));
    const loaded: Record<string, Loaded> = {};
    const files = new Map<string, FileDiffMetadata>();
    try {
      const patch = paths.length === 1 ? await api.patch(paths[0]!) : await api.patches(paths);
      // Unique cache key per load: the renderer otherwise treats two diffs with
      // undefined keys as the same and reuses stale highlighted lines.
      const parsed = parsePatchFiles(patch, `s${snap.version}c${snap.context}t${Date.now()}`);
      for (const p of parsed) for (const f of p.files) files.set(f.name, f);
      for (const p of paths) {
        const f = files.get(p);
        loaded[p] = f ? { kind: 'diff', fileDiff: f } : { kind: 'error', message: 'patch missing for file' };
      }
    } catch (e) {
      for (const p of paths) loaded[p] = { kind: 'error', message: String(e) };
    }
    if (!current(g)) return;
    // First paint: the parsed patches, straight away.
    set((s) => ({ loaded: { ...s.loaded, ...loaded }, ...regen(s, Object.keys(loaded)) }));
    // A submodule's patch is the commit-id change itself; there is no file to hydrate from.
    hydrate(
      paths.filter((p) => !byPath.get(p)!.submodule),
      files,
      loaded,
      g,
    );
  };

  /**
   * Background: swap partial (modified-file) diffs for ones hydrated with full
   * contents so highlighting sees the whole file; a hunk alone may start inside
   * a string or comment. Added and deleted files already carry their whole
   * contents in the patch. Hydrated files that finish within one frame commit
   * together; the rendered diff is never mutated, a hydrated clone replaces it.
   *
   * Every batch feeds one queue drained by HYDRATION_WORKERS workers, so the
   * concurrency is bounded across batches and earlier batches hydrate first.
   */
  interface HydrationJob {
    path: string;
    file: FileDiffMetadata;
    /** The entry the hydration replaces; a reload since then means it is of stale content. */
    replaces: Loaded;
    g: number;
  }
  const HYDRATION_WORKERS = 4;
  const hydrationQueue: HydrationJob[] = [];
  let hydrationWorkers = 0;
  const hydrate = (
    paths: string[],
    files: Map<string, FileDiffMetadata>,
    committed: Record<string, Loaded>,
    g: number,
  ) => {
    for (const p of paths) {
      const f = files.get(p);
      if (f?.isPartial && (f.type === 'change' || f.type === 'rename-changed' || f.type === 'rename-pure')) {
        hydrationQueue.push({ path: p, file: f, replaces: committed[p]!, g });
      }
    }
    while (hydrationWorkers < HYDRATION_WORKERS && hydrationWorkers < hydrationQueue.length) {
      hydrationWorkers++;
      void hydrationWorker();
    }
  };
  const hydrationWorker = async () => {
    try {
      for (;;) {
        const job = hydrationQueue.shift();
        if (!job) return;
        // A newer transition or a reload of the file drops the job: `begin` aborted the requests in flight.
        if (!current(job.g) || get().loaded[job.path] !== job.replaces) continue;
        await hydrateOne(job);
      }
    } finally {
      hydrationWorkers--;
    }
  };
  const hydrateOne = async ({ path, file: f, replaces, g }: HydrationJob) => {
    const stale = () => !current(g) || get().loaded[path] !== replaces;
    try {
      const oldPath = f.prevName ?? f.name;
      const [o, n] = await Promise.all([fetchFile(oldPath, 'old'), fetchFile(f.name, 'new')]);
      // Dropped if a newer transition ran or this file was reloaded meanwhile.
      if (stale()) return;
      const fileDiff = hydratePartialDiff('clone', f, {
        oldFile: { name: oldPath, contents: o.contents },
        newFile: { name: f.name, contents: n.contents },
      });
      queueHydrated({ path, fileDiff, old: o.contents, new: n.contents, replaces, g });
    } catch {
      /* keep the partial diff; highlighting degrades but the diff still renders */
    }
  };

  /**
   * Hydrated diffs waiting for one store commit. Every commit rebuilds the item list and the nav
   * model over all files, so results that land within a frame are applied as one transaction.
   */
  interface Hydrated {
    path: string;
    fileDiff: FileDiffMetadata;
    old: string;
    new: string;
    /** The entry this replaces; a reload since then means the hydration is of stale content. */
    replaces: Loaded;
    g: number;
  }
  let hydrated: Hydrated[] = [];
  let hydratedFlush: (() => void) | null = null;
  const queueHydrated = (h: Hydrated) => {
    hydrated.push(h);
    if (hydratedFlush) return;
    hydratedFlush = flushHydrated;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushHydrated);
    else setTimeout(flushHydrated, 0);
  };
  const flushHydrated = () => {
    hydratedFlush = null;
    const batch = hydrated;
    hydrated = [];
    // The identity checks run again at commit time: a transition or reload may have run since the queueing.
    const live = batch.filter((h) => current(h.g) && get().loaded[h.path] === h.replaces);
    if (live.length === 0) return;
    set((s) => {
      const loaded = { ...s.loaded };
      const contents = { ...s.contents };
      for (const h of live) {
        loaded[h.path] = { kind: 'diff', fileDiff: h.fileDiff };
        contents[h.path] = { ...contents[h.path], old: h.old, new: h.new };
      }
      return {
        loaded,
        contents,
        ...regen(
          s,
          live.map((h) => h.path),
        ),
      };
    });
  };

  const applySnapshot = async (next: Snapshot, g: number) => {
    const prev = get().snapshot;
    const modeChanged = prev == null || prev.mode.commentKey !== next.mode.commentKey;
    const contextChanged = prev != null && prev.context !== next.context;
    // `ChangedFile` names only the new blob. The old side moving (amend, rebase, a fetched base)
    // keeps blob, status and counts and still changes every patch, so it invalidates like context does.
    const oldMoved = prev != null && prev.oldSha !== next.oldSha;
    const sidesMoved = oldMoved || (prev != null && prev.newSha !== next.newSha);
    const prevChanged = new Map(prev?.changed.map((f) => [f.path, f]) ?? []);
    const nextChanged = new Map(next.changed.map((f) => [f.path, f]));

    const loaded: Record<string, Loaded> = modeChanged ? {} : { ...get().loaded };
    // Cached sides of any path are stale once either side moved.
    const contents = modeChanged || sidesMoved ? {} : { ...get().contents };
    const reload: string[] = [];
    for (const f of next.changed) {
      const p = prevChanged.get(f.path);
      if (modeChanged || contextChanged || oldMoved || !p || !sameChange(p, f) || loaded[f.path] == null) {
        // The stale diff stays on screen until its replacement lands: dropping it would remove the
        // card and reflow everything below it under the reader's eyes. A fresh wrapper object makes
        // a hydration of the old content still in flight miss its identity check and stand down.
        const stale = loaded[f.path];
        if (stale) loaded[f.path] = { ...stale };
        delete contents[f.path];
        reload.push(f.path);
      }
    }
    // Previously changed files that are now unchanged.
    for (const path of prevChanged.keys()) {
      if (!nextChanged.has(path)) {
        delete loaded[path];
        delete contents[path];
      }
    }
    // The file view closes with its mode or its file; it refetches when the file's change moved
    // (its new side differs), when it entered or left the changed set (its cached contents were
    // dropped), or when a side moved: an unchanged file's content follows the commit it is read from.
    const prevView = get().fileView;
    let fileView = modeChanged || prevView == null || !next.tree.includes(prevView.path) ? null : prevView;
    const viewMoved =
      prevView != null &&
      (sidesMoved ||
        prevChanged.has(prevView.path) !== nextChanged.has(prevView.path) ||
        reload.includes(prevView.path));
    // Its item, like a stale diff, stays up until the refetch commits.
    if (fileView && viewMoved) delete contents[fileView.path];
    const collapsed = modeChanged ? {} : { ...get().collapsed };
    // A watcher refresh must not take the comment being typed with it; only a new mode or a vanished file does.
    const draft = get().draft;
    const keepDraft = draft != null && !modeChanged && (nextChanged.has(draft.path) || fileView?.path === draft.path);
    resyncing = false;
    set({ snapshot: next, loaded, contents, fileView, collapsed, error: null, draft: keepDraft ? draft : null });
    if (modeChanged) {
      // Positions, matches and revealed ranges all name lines of the previous mode.
      set((s) => ({
        selection: null,
        visualAnchor: null,
        replyTo: null,
        editingId: null,
        jumps: [],
        jumpIndex: 0,
        revealed: {},
        reveal: null,
        scrollTarget: null,
        search: { ...s.search, open: false, kind: 'text', direction: 1, matches: [], index: -1 },
      }));
    }
    await Promise.all([
      loadPatches(next, reload, g),
      ...(fileView && (viewMoved || !fileView.item) ? [loadFileView(fileView.path, g, true)] : []),
    ]);
  };

  /**
   * Open the file view on `path` and fetch its new side. Discarded if a transition ran since `g`
   * or the view moved on. The selection is dropped first: it named an item of the other view.
   * `refresh` refetches the view already open on `path`, keeping its item and cursor until the
   * response commits.
   */
  const loadFileView = async (path: string, g: number, refresh = false) => {
    // Moving between files inside the view keeps the original way back to the diff.
    const from = get().fileView?.from ?? { position: currentPosition(), activePath: get().activePath };
    if (!refresh)
      set({
        fileView: { path, item: null, from },
        selection: null,
        visualAnchor: null,
        draft: null,
        focusedThread: null,
      });
    let item: Loaded;
    let contents: string | undefined;
    try {
      const res = await fetchFile(path, 'new');
      contents = res.contents;
      item = res.binary
        ? { kind: 'binary' }
        : { kind: 'file', file: { name: path, contents: res.contents, cacheKey: `${path}@full@${Date.now()}` } };
    } catch (e) {
      item = { kind: 'error', message: String(e) };
    }
    if (!current(g) || get().fileView?.path !== path) return;
    set((s) => ({
      fileView: { path, item, from: s.fileView?.from ?? from },
      ...regen(s, [path]),
      contents: contents == null ? s.contents : { ...s.contents, [path]: { ...s.contents[path], new: contents } },
    }));
  };

  /** The navigation model, rebuilt only when one of its inputs changed: every cursor step asks for it. */
  let navCache: { inputs: unknown[]; items: NavItem[] } | null = null;
  const nav = (): NavItem[] => {
    const s = get();
    if (!s.snapshot) return [];
    const inputs = [s.snapshot, s.loaded, s.gens, s.revealed, s.collapsed, s.viewed, s.config, s.diffStyle, s.fileView];
    if (navCache && navCache.inputs.every((v, i) => v === inputs[i])) return navCache.items;
    const items = buildNav(s.snapshot, s.loaded, s.gens, (p) => isCollapsed(s, p), s.revealed, s.diffStyle, s.fileView);
    navCache = { inputs, items };
    return items;
  };

  const currentPosition = (): JumpPosition | null => {
    const sel = get().selection;
    if (!sel) return null;
    const path = pathFromItemId(sel.id);
    return { path, side: sideOf(sel), line: sel.range.end, ...(get().fileView?.path === path ? { full: true } : {}) };
  };

  /** Remember where we are before a jump (vim jumplist semantics). */
  const recordJump = () => {
    if (silent) return;
    const pos = currentPosition();
    if (!pos) return;
    const { jumps, jumpIndex } = get();
    const kept = jumps.slice(0, jumpIndex);
    const last = kept[kept.length - 1];
    if (
      last &&
      last.path === pos.path &&
      last.line === pos.line &&
      last.side === pos.side &&
      !!last.full === !!pos.full
    ) {
      set({ jumps: kept, jumpIndex: kept.length });
      return;
    }
    const next = [...kept, pos].slice(-100);
    set({ jumps: next, jumpIndex: next.length });
  };

  /** Expand a collapsed file so a jump into it has something to land on. */
  const ensureExpanded = (path: string) => {
    if (!isCollapsed(get(), path)) return;
    set((s) => ({ collapsed: { ...s.collapsed, [path]: false } }));
  };

  /** Move to a jumplist entry without recording another jump. */
  let silent = false;
  /** Run `fn` with the jumplist closed: positions it passes through are not the reader's. */
  const quietly = <T>(fn: () => T): T => {
    silent = true;
    const done = () => {
      silent = false;
    };
    let out: T;
    try {
      out = fn();
    } catch (e) {
      done();
      throw e;
    }
    if (out instanceof Promise) return out.finally(done) as T;
    done();
    return out;
  };
  const goToPositionSilently = async (pos: JumpPosition) => {
    // Switching views first, outside the silent window: the load records no jump of its own.
    if (pos.full && get().fileView?.path !== pos.path) {
      const g = generation;
      await loadFileView(pos.path, g);
      if (!current(g) || get().fileView?.path !== pos.path) return;
    } else if (!pos.full && get().fileView) {
      set({ fileView: null, selection: null, visualAnchor: null, draft: null, focusedThread: null });
    }
    silent = true;
    try {
      goToPosition(pos);
    } finally {
      silent = false;
    }
  };

  const goToPosition = (pos: JumpPosition) => {
    if (!pos.full) ensureExpanded(pos.path);
    const items = nav();
    const itemIndex = items.findIndex((i) => i.path === pos.path);
    if (itemIndex === -1) return;
    const item = items[itemIndex]!;
    const side = pos.side === 'old' ? 'deletions' : 'additions';
    const rowIndex = item.rows.findIndex((r) => r.line === pos.line && r.side === side);
    if (rowIndex !== -1) {
      placeCursor({ itemIndex, rowIndex }, false, 'eye');
      return;
    }
    set((s) => ({
      selection: { id: item.id, range: { start: pos.line, side, end: pos.line, endSide: side } },
      activePath: pos.path,
      scrollTarget: {
        id: item.id,
        line: pos.line,
        side: pos.side,
        align: 'eye',
        nonce: (s.scrollTarget?.nonce ?? 0) + 1,
      },
    }));
  };

  /**
   * After a file collapses (viewed / zc): keep its header at the top of the view
   * and move the cursor to the first hunk of the next open file, so the eye has
   * an anchor instead of content silently vanishing.
   */
  const afterCollapse = (path: string) => {
    const items = nav();
    const idx = items.findIndex((i) => i.path === path);
    if (idx === -1) return;
    const item = items[idx]!;
    let next: Cursor | null = null;
    for (let i = idx + 1; i < items.length; i++) {
      const it = items[i]!;
      if (it.collapsed || it.rows.length === 0) continue;
      const hunk = it.rows.findIndex((r) => r.hunkStart);
      next = { itemIndex: i, rowIndex: hunk === -1 ? 0 : hunk };
      break;
    }
    const sel = next ? selectionFor(items, next) : null;
    set((s) => ({
      selection: sel,
      visualAnchor: null,
      draft: null,
      activePath: next ? items[next.itemIndex]!.path : path,
      scrollTarget: { id: item.id, align: 'start', nonce: (s.scrollTarget?.nonce ?? 0) + 1 },
    }));
  };

  /** Place the cursor: update selection, active path, and scroll into view. */
  /** A scroll request that pins the cursor line at `edge`; the caller checks that a selection exists. */
  const cursorTarget = (s: ReviewState, edge: 'top' | 'bottom' | 'eye') => {
    const sel = s.selection!;
    return { id: sel.id, line: sel.range.end, side: sideOf(sel), align: edge, nonce: (s.scrollTarget?.nonce ?? 0) + 1 };
  };

  const placeCursor = (cur: Cursor | null, keepAnchor = false, align: 'nearest' | 'eye' = 'nearest') => {
    if (!cur) return;
    if (align === 'eye') recordJump();
    const items = nav();
    const anchor = keepAnchor ? get().visualAnchor : null;
    const sel = selectionFor(items, cur, anchor);
    const item = items[cur.itemIndex];
    if (!sel || !item) return;
    const row = item.rows[cur.rowIndex]!;
    set((s) => ({
      selection: sel,
      activePath: item.path,
      visualAnchor: keepAnchor ? s.visualAnchor : null,
      focusedThread: null,
      scrollTarget: {
        id: item.id,
        line: row.line,
        side: row.side === 'deletions' ? 'old' : 'new',
        align,
        nonce: (s.scrollTarget?.nonce ?? 0) + 1,
      },
    }));
  };

  /** Open `path` and put the cursor on its new-side `line` at eye level, expanding collapsed context if needed. */
  const jumpToLine = async (path: string, line: number) => {
    // One jumplist entry per jump, taken at the origin. Opening the file parks the cursor on its
    // first hunk on the way; recording that would make Ctrl+o land somewhere the reader never was.
    recordJump();
    await quietly(() => get().openFile(path));
    ensureExpanded(path);
    const items = nav();
    const itemIndex = items.findIndex((i) => i.path === path);
    if (itemIndex === -1) return;
    const item = items[itemIndex]!;
    const rowIndex = item.rows.findIndex((r) => r.side === 'additions' && r.line === line);
    if (rowIndex !== -1) {
      quietly(() => placeCursor({ itemIndex, rowIndex }, false, 'eye'));
      return;
    }
    // The line sits in collapsed context: have the viewer expand it, then center it.
    set((s) => ({
      selection: { id: item.id, range: { start: line, side: 'additions', end: line, endSide: 'additions' } },
      activePath: path,
      visualAnchor: null,
      reveal: { id: item.id, path, line, nonce: (s.reveal?.nonce ?? 0) + 1 },
    }));
  };

  /**
   * Why symbol navigation cannot run right now, or null when it can. With a path, the
   * answer is about the server for that file's language; without one, about any of them.
   */
  const blocker = (path?: string): string | null => {
    const { lsp, snapshot } = get();
    if (!lsp.enabled) return lspBlocker(lsp);
    if (!snapshot || !followsCheckout(snapshot))
      return 'Symbol navigation needs the new side to be the worktree or the checked-out commit';
    return lspBlocker(lsp, path);
  };

  /** The LSP position for a hovered token, or null after flashing why not. */
  const lspPosition = (target: TokenTarget | null | undefined): LspPosition | null => {
    const reason =
      blocker() ??
      (!target
        ? 'Hover a symbol first'
        : target.side === 'old'
          ? 'Symbol navigation works on the new side only'
          : blocker(target.path));
    if (reason) {
      get().flash(reason);
      return null;
    }
    return { path: target!.path, line: target!.line, col: target!.col };
  };

  // Every dropped result has a reason the user can act on: an ignored dir needs a
  // .gitignore or venv change, another worktree means the server's search path
  // points at the wrong checkout.
  const noDefinitionMessage = (symbol: string, res: LspLocationsResponse, what = 'definition') => {
    if (res.hiddenPath) return `${symbol} resolves to ${res.hiddenPath}, which the diff hides (ignored or untracked)`;
    if (res.externalPath) return `${symbol} resolves to ${res.externalPath}, outside the repository`;
    if (res.external) return `${symbol} is defined outside the repository`;
    return `No ${what} found for ${symbol}`;
  };

  /**
   * Whether a search response may commit: its snapshot is still current and no newer search
   * started or closed the bar. A dropped response still owns the spinner unless a newer one does.
   */
  const searchOwned = (g: number, t: number): boolean => {
    if (current(g) && searchSeq.latest(t)) return true;
    if (searchSeq.latest(t)) set((s) => ({ search: { ...s.search, loading: false } }));
    return false;
  };

  /** gd / gy: ask the language server where `target` (or its type) lives and jump to the first answer. */
  const jumpToLspLocation = async (target: TokenTarget | null | undefined, kind: 'definition' | 'type definition') => {
    get().closeSymbolMenu();
    const pos = lspPosition(target);
    if (!pos) return;
    // The answer names lines of the snapshot the question was asked about.
    const g = generation;
    try {
      const res = await (kind === 'definition' ? api.lspDefinition(pos) : api.lspTypeDefinition(pos));
      if (!current(g)) return;
      const loc = res.locations[0];
      if (!loc) return get().flash(noDefinitionMessage(target!.text, res, kind));
      // A function's "type" comes back as every class in its signature (pyrefly lists parameter
      // types before the return type). Picking the first would jump somewhere unasked; let the reader choose.
      if (kind === 'type definition' && res.locations.length > 1) {
        const items = res.locations.map((l) => ({ path: l.path, line: l.line, text: l.text }));
        set({ references: { open: true, kind: 'types', symbol: target!.text, items, index: 0 } });
        return;
      }
      await jumpToLine(loc.path, loc.line);
    } catch (e) {
      if (current(g)) report(kind === 'definition' ? 'Go to definition' : 'Go to type definition', e);
    }
  };

  const currentCursor = () => cursorFromSelection(nav(), get().selection);

  const threadAtCursor = (): CommentThread | undefined => {
    const s = get();
    const sel = s.selection;
    if (!sel) return undefined;
    const path = pathFromItemId(sel.id);
    const side = sideOf(sel);
    const line = sel.range.end;
    return visibleThreads(s).find(
      (t) => t.anchor.path === path && t.anchor.side === side && line >= t.anchor.startLine && line <= t.anchor.endLine,
    );
  };

  /** The authoritative list replaces the store's; threads that did not change keep their objects. */
  const acceptThreads = (next: CommentThread[]) => set({ threads: reuseThreads(get().threads, next) });

  /** A thread mutation, then the authoritative list; a failure becomes a toast. */
  const mutateThreads = async (what: string, call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (e) {
      return report(what, e);
    }
    await get().refreshThreads();
  };

  /**
   * Persists an optimistic viewed change; on failure the server's marks replace the guess.
   * The response commits only in the mode it was made for and only if no newer viewed
   * request (mutation or refresh) has started since.
   */
  const persistViewed = async (what: string, call: () => Promise<ViewedEntry[]>) => {
    const m = modeGeneration;
    let t = 0;
    try {
      const viewed = await viewedWrites(() => {
        t = viewedSeq.start();
        return call();
      });
      if (modeGeneration === m && viewedSeq.latest(t)) set({ viewed });
    } catch (e) {
      if (modeGeneration !== m) return;
      report(what, e);
      void get().refreshViewed();
    }
  };

  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    layout: readLayout(),
    setLayout(patch) {
      const layout = { ...get().layout, ...patch };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      } catch {
        /* ignore */
      }
      set({ layout });
    },
    theme: readTheme(),
    setTheme(theme) {
      storeTheme(theme);
      applyTheme(theme);
      // One update: the viewer remounts per theme and would come back scrolled to the top, so the
      // cursor line goes back to the gaze point in the same render, before anything paints.
      set((s) => ({ theme, ...(s.selection ? { scrollTarget: cursorTarget(s, 'eye') } : {}) }));
    },
    visualAnchor: null,
    editingId: null,
    setEditingId(id) {
      set({ editingId: id });
    },
    replyTo: null,
    focusedThread: null,
    focusThread(threadId) {
      set({ focusedThread: threadId });
    },
    openReply(threadId) {
      const t = get().threads.find((x) => x.id === threadId);
      if (!t) return;
      set({ replyTo: threadId, draft: null, activePath: t.anchor.path });
    },
    closeReply() {
      if (get().replyTo) set({ replyTo: null });
    },
    modeMenuOpen: false,
    setModeMenuOpen(open) {
      set({ modeMenuOpen: open });
    },
    pickModeEntry(n) {
      set({ modeMenuOpen: false });
      const req: ModeRequest | null =
        n === 1
          ? { kind: 'pr' }
          : n === 2
            ? { kind: 'branch' }
            : n === 3
              ? { kind: 'working' }
              : n === 4
                ? lastCommitsRequest(get().lastCommits)
                : null;
      if (req) void get().switchMode(req);
      else set({ modeMenuOpen: true, twoRefsOpen: true });
    },
    twoRefsOpen: false,
    setTwoRefsOpen(open) {
      set({ twoRefsOpen: open });
    },
    lastCommits: 1,
    setLastCommits(n) {
      set({ lastCommits: Math.max(1, Math.floor(n)) });
    },
    helpOpen: false,
    setHelpOpen(open) {
      set({ helpOpen: open });
    },
    treeModel: null,
    setTreeModel(model) {
      set({ treeModel: model });
    },
    toast: null,
    report,
    flash(message) {
      set({ toast: message });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set({ toast: null }), TOAST_MS);
    },
    search: {
      open: false,
      kind: 'text',
      direction: 1,
      ignoreCase: true,
      regex: false,
      scope: 'diff',
      path: null,
      focusNonce: 0,
      query: '',
      matches: [],
      index: -1,
      loading: false,
      truncated: false,
    },
    openSearch(scope) {
      set((s) => ({
        search: {
          ...s.search,
          open: true,
          kind: 'text',
          direction: 1,
          scope: scope ?? s.search.scope,
          focusNonce: s.search.focusNonce + 1,
        },
      }));
    },
    setSearchOptions(opts) {
      set((s) => ({ search: { ...s.search, ...opts } }));
      const { query, kind } = get().search;
      if (kind === 'text' && query) void get().runSearch(query);
    },
    closeSearch() {
      // Escape cancels a search in flight: its matches would move the cursor for a bar no longer shown.
      searchSeq.start();
      set((s) => ({
        search: { ...s.search, open: false, kind: 'text', direction: 1, matches: [], index: -1, loading: false },
      }));
    },
    async runSearch(query) {
      const g = generation;
      const t = searchSeq.start();
      // A file-scoped search is pinned to the file the reader is in when it runs; `/` again re-pins.
      const path = get().search.scope === 'file' ? currentPath(get()) : null;
      set((s) => ({ search: { ...s.search, kind: 'text', direction: 1, query, path, loading: true } }));
      try {
        const { ignoreCase, regex, scope } = get().search;
        if (scope === 'file' && !path) {
          set((s) => ({ search: { ...s.search, matches: [], index: -1, loading: false } }));
          return get().flash('No file to search in');
        }
        const res = await api.search(query, { ignoreCase, regex, scope, ...(path ? { path } : {}) });
        if (!searchOwned(g, t)) return;
        set((s) => ({
          search: { ...s.search, matches: res.matches, truncated: res.truncated, index: -1, loading: false },
        }));
        if (res.matches.length) get().moveMatch(1);
        else
          get().flash(
            scope === 'file'
              ? `No matches for “${query}” in ${path}`
              : scope === 'diff'
                ? `No matches for “${query}” in the diff`
                : `No matches for “${query}”`,
          );
      } catch (e) {
        if (!searchOwned(g, t)) return;
        set((s) => ({ search: { ...s.search, loading: false } }));
        report('Search', e);
      }
    },
    moveMatch(delta) {
      const { search } = get();
      const n = search.matches.length;
      if (!n) return;
      const d = delta * search.direction;
      const index = ((search.index < 0 ? (d === 1 ? -1 : 0) : search.index) + d + n) % n;
      const m = search.matches[index]!;
      set({ search: { ...search, index } });
      void jumpToLine(m.path, m.line);
    },
    async searchWord(delta) {
      const word = lspTarget.get()?.text;
      if (!word) return get().flash('Focus a word first (w / b, or hover one)');
      const g = generation;
      const t = searchSeq.start();
      set((s) => ({
        search: {
          ...s.search,
          open: true,
          kind: 'word',
          direction: delta,
          query: word,
          matches: [],
          index: -1,
          loading: true,
          truncated: false,
        },
      }));
      try {
        const res = await api.search(word, { word: true, scope: 'repo' });
        if (!searchOwned(g, t)) return;
        const matches = res.matches;
        // Start from the occurrence just past the cursor in the requested direction, wrapping like vim.
        const order = new Map(get().snapshot?.tree.map((p, i) => [p, i]) ?? []);
        const at = currentPosition();
        const rank = (path: string) => order.get(path) ?? Infinity;
        // Positive when the match lies after the cursor in reading order.
        const compare = (m: SearchMatch) => (at ? rank(m.path) - rank(at.path) || m.line - at.line : delta);
        let index =
          delta === 1 ? matches.findIndex((m) => compare(m) > 0) : matches.findLastIndex((m) => compare(m) < 0);
        if (index === -1 && matches.length) index = delta === 1 ? 0 : matches.length - 1;
        set((s) => ({ search: { ...s.search, matches, truncated: res.truncated, index, loading: false } }));
        const m = matches[index];
        if (m) void jumpToLine(m.path, m.line);
        else get().flash(`No other occurrence of “${word}”`);
      } catch (e) {
        if (!searchOwned(g, t)) return;
        set((s) => ({ search: { ...s.search, loading: false } }));
        report('Search', e);
      }
    },
    lsp: { enabled: false, servers: [], missing: [] },
    setLspStatus(status) {
      set({ lsp: status });
    },
    symbolMenu: null,
    async openSymbolMenu(target, x, y) {
      // With language servers off every action would only flash why: no menu to offer.
      if (!get().lsp.enabled) return;
      get().closeHover();
      const t = ++menuSeq;
      // Only the server can answer on the new side; elsewhere the menu's actions flash their own reason.
      if (target.side === 'new' && !blocker(target.path)) {
        const g = generation;
        let kind: string | null = null;
        try {
          kind = (await api.lspTokenKind({ path: target.path, line: target.line, col: target.col }))?.kind ?? null;
        } catch {
          /* no classification: open the menu as before */
        }
        // A close or a later click while the answer was in flight wins over this one.
        if (!current(g) || t !== menuSeq) return;
        if (kind === 'keyword') return;
      }
      set({ symbolMenu: { target, x, y } });
    },
    closeSymbolMenu() {
      menuSeq++;
      if (get().symbolMenu) set({ symbolMenu: null });
    },
    hover: null,
    async requestHover(target, anchor) {
      const t = ++hoverSeq;
      if (get().symbolMenu || target.side === 'old' || blocker(target.path)) return;
      const g = generation;
      try {
        const res = await api.lspHover({ path: target.path, line: target.line, col: target.col });
        if (!current(g) || t !== hoverSeq || get().symbolMenu) return;
        set({ hover: res.contents ? { target, contents: res.contents, anchor } : null });
      } catch {
        /* a hover is advisory: a failed one shows nothing */
      }
    },
    async showHover() {
      const target = get().symbolMenu?.target ?? lspTarget.get();
      if (!lspPosition(target)) return;
      get().closeSymbolMenu();
      const r = lspTarget.element()?.getBoundingClientRect();
      const anchor = r ? { left: r.left, top: r.top, bottom: r.bottom } : { left: 0, top: 0, bottom: 0 };
      // The tooltip closes on any keydown, and its listener may run after the keymap's within the same
      // dispatch; requesting after the dispatch keeps that close from dropping this answer as stale.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const t = hoverSeq + 1;
      await get().requestHover(target!, anchor);
      if (t === hoverSeq && !get().hover) get().flash(`No hover information for ${target!.text}`);
    },
    closeHover() {
      hoverSeq++;
      if (get().hover) set({ hover: null });
    },
    async goToDefinition(target = get().symbolMenu?.target ?? lspTarget.get()) {
      await jumpToLspLocation(target, 'definition');
    },
    async goToTypeDefinition(target = get().symbolMenu?.target ?? lspTarget.get()) {
      await jumpToLspLocation(target, 'type definition');
    },
    async goToLink(path, line) {
      get().closeHover();
      get().closeSymbolMenu();
      if (line == null) await get().openFile(path);
      else await jumpToLine(path, line);
    },
    async findReferences(target = get().symbolMenu?.target ?? lspTarget.get()) {
      get().closeSymbolMenu();
      const pos = lspPosition(target);
      if (!pos) return;
      const g = generation;
      try {
        const res = await api.lspReferences(pos);
        if (!current(g)) return;
        const items = res.locations.map((l) => ({ path: l.path, line: l.line, text: l.text }));
        if (items.length === 0) return get().flash(`No references to ${target!.text}`);
        // Start on the reference after the origin, so Enter moves forward through the list.
        const origin = items.findIndex((m) => m.path === pos.path && m.line === pos.line);
        const index = origin === -1 ? 0 : (origin + 1) % items.length;
        set({ references: { open: true, kind: 'references', symbol: target!.text, items, index } });
      } catch (e) {
        if (current(g)) report('Find references', e);
      }
    },
    references: { open: false, kind: 'references', symbol: '', items: [], index: -1 },
    moveReference(delta) {
      const r = get().references;
      const n = r.items.length;
      if (!n) return;
      set({ references: { ...r, index: (Math.max(r.index, 0) + delta + n) % n } });
    },
    pickReference() {
      const r = get().references;
      const m = r.items[r.index];
      get().closeReferences();
      if (!m) return;
      // Hand the list to the search bar so n / N continue from the picked reference. A type pick is one-off.
      if (r.kind === 'references') {
        set((s) => ({
          search: {
            ...s.search,
            open: true,
            kind: 'references',
            direction: 1,
            query: r.symbol,
            matches: r.items,
            index: r.index,
            loading: false,
            truncated: false,
          },
        }));
      }
      void jumpToLine(m.path, m.line);
    },
    closeReferences() {
      set((s) => ({ references: { ...s.references, open: false } }));
    },
    symbols: { open: false, scope: 'document', path: null, query: '', all: [], items: [], index: -1, loading: false },
    async openSymbols(scope) {
      const path = scope === 'document' ? get().activePath : null;
      if (scope === 'document' && !path) return get().flash('Move to a file first');
      const reason = blocker(path ?? undefined);
      if (reason) return get().flash(reason);
      set({
        symbols: {
          open: true,
          scope,
          path: scope === 'document' ? path : null,
          query: '',
          all: [],
          items: [],
          index: -1,
          loading: scope === 'document',
        },
      });
      if (scope !== 'document') return;
      const g = generation;
      try {
        const all = await api.lspSymbols({ path: path! });
        const s = get().symbols;
        if (!s.open || s.scope !== 'document' || s.path !== path) return;
        // Symbol lines belong to the snapshot they were listed from.
        if (!current(g)) return set({ symbols: { ...s, loading: false } });
        set({ symbols: { ...s, all, items: filterSymbols(all, s.query), index: all.length ? 0 : -1, loading: false } });
      } catch (e) {
        get().closeSymbols();
        report('Document symbols', e);
      }
    },
    async querySymbols(query) {
      const s = get().symbols;
      if (!s.open) return;
      if (s.scope === 'document') {
        const items = filterSymbols(s.all, query);
        return set({ symbols: { ...s, query, items, index: items.length ? 0 : -1 } });
      }
      set({ symbols: { ...s, query, loading: query.trim().length > 0 } });
      cancelSymbolWait();
      if (!query.trim()) return set((st) => ({ symbols: { ...st.symbols, items: [], index: -1 } }));
      // One server round trip per pause in typing, not per keystroke: each query
      // resolves every hit's path through the snapshot.
      await new Promise<void>((wake) => {
        const timer = setTimeout(() => {
          symbolWait = null;
          wake();
        }, WORKSPACE_SYMBOL_DEBOUNCE_MS);
        symbolWait = { timer, wake };
      });
      if (get().symbols.query !== query || !get().symbols.open) return;
      const g = generation;
      try {
        const items = await api.lspSymbols({ q: query });
        const now = get().symbols;
        // A newer query owns the list; a newer snapshot may have moved every symbol.
        if (!now.open || now.query !== query) return;
        if (!current(g)) return set({ symbols: { ...now, loading: false } });
        set({ symbols: { ...now, items, index: items.length ? 0 : -1, loading: false } });
      } catch (e) {
        set((st) => ({ symbols: { ...st.symbols, loading: false } }));
        report('Workspace symbols', e);
      }
    },
    moveSymbol(delta) {
      const s = get().symbols;
      const n = s.items.length;
      if (!n) return;
      set({ symbols: { ...s, index: (Math.max(s.index, 0) + delta + n) % n } });
    },
    pickSymbol() {
      const s = get().symbols;
      const sym = s.items[s.index];
      get().closeSymbols();
      if (sym) void jumpToLine(sym.path, sym.line);
    },
    closeSymbols() {
      set((s) => ({ symbols: { ...s.symbols, open: false, items: [], all: [], index: -1, loading: false } }));
    },
    moveCursor(delta) {
      const items = nav();
      placeCursor(step(items, cursorFromSelection(items, get().selection), delta), get().visualAnchor != null);
    },
    jumps: [],
    jumpIndex: 0,
    jumpBack() {
      // From the file view, Ctrl+o always means back to the diff, where it was left.
      if (get().fileView) return get().closeFullFile();
      const { jumps, jumpIndex } = get();
      if (jumpIndex === 0) return;
      let list = jumps;
      let index = jumpIndex;
      if (index === list.length) {
        // Leaving the newest position: save it so Ctrl+i can return.
        const pos = currentPosition();
        if (pos) list = [...list, pos];
      }
      index -= 1;
      set({ jumps: list, jumpIndex: index });
      const target = list[index];
      if (target) void goToPositionSilently(target);
    },
    jumpForward() {
      const { jumps, jumpIndex } = get();
      if (jumpIndex >= jumps.length - 1) return;
      const index = jumpIndex + 1;
      set({ jumpIndex: index });
      const target = jumps[index];
      if (target) void goToPositionSilently(target);
    },
    scrollCursorTo(edge) {
      if (!get().selection) return get().flash('No line under the cursor');
      set((s) => ({ scrollTarget: cursorTarget(s, edge) }));
    },
    moveCursorBy(rows) {
      const items = nav();
      const dir: 1 | -1 = rows < 0 ? -1 : 1;
      let cur = currentCursor();
      for (let i = 0; i < Math.abs(rows); i++) {
        const next = step(items, cur, dir);
        if (!next || (cur && next.itemIndex === cur.itemIndex && next.rowIndex === cur.rowIndex)) break;
        cur = next;
      }
      placeCursor(cur, get().visualAnchor != null, 'eye');
    },
    async goToLine(line) {
      const s = get();
      const path = currentPath(s);
      if (!path) return s.flash('No file to jump in');
      await jumpToLine(path, line);
    },
    moveFile(delta) {
      const items = nav();
      if (!items.length) return;
      // A binary or unloaded file has no rows, so no selection: the active file stands in for the cursor there.
      const at = items.findIndex((i) => i.path === get().activePath);
      const from = currentCursor() ?? (at === -1 ? null : { itemIndex: at, rowIndex: 0 });
      const cur =
        delta === 'first'
          ? { itemIndex: 0, rowIndex: 0 }
          : delta === 'last'
            ? { itemIndex: items.length - 1, rowIndex: 0 }
            : stepFile(items, from, delta);
      if (!cur) return;
      const item = items[cur.itemIndex]!;
      recordJump();
      if (item.rows.length === 0) {
        set((s) => ({
          selection: null,
          activePath: item.path,
          scrollTarget: { id: item.id, nonce: (s.scrollTarget?.nonce ?? 0) + 1 },
        }));
        return;
      }
      placeCursor(cur);
      set((s) => ({ scrollTarget: { id: item.id, align: 'start', nonce: (s.scrollTarget?.nonce ?? 0) + 1 } }));
    },
    moveHunk(delta) {
      placeCursor(stepHunk(nav(), currentCursor(), delta), false, 'eye');
    },
    toggleVisual() {
      const cur = currentCursor();
      if (get().visualAnchor) {
        set({ visualAnchor: null });
        if (cur) placeCursor(cur);
        return;
      }
      if (!cur) {
        const first = step(nav(), null, 1);
        if (first) placeCursor(first);
        set({ visualAnchor: currentCursor() });
        return;
      }
      set({ visualAnchor: cur });
    },
    editCommentAtCursor() {
      const t = threadAtCursor();
      const last = t?.messages[t.messages.length - 1];
      if (last) get().setEditingId(last.id);
    },
    async deleteCommentAtCursor() {
      const t = threadAtCursor();
      if (t) await get().deleteThread(t.id);
    },
    async toggleResolvedAtCursor() {
      const t = threadAtCursor();
      if (!t) return get().flash('No thread under the cursor');
      await get().setResolved(t.id, !t.resolved);
      get().flash(t.resolved ? 'Thread reopened' : 'Thread resolved');
    },
    async toggleViewedAtCursor() {
      const path = get().activePath;
      const f = path ? get().snapshot?.changed.find((x) => x.path === path) : undefined;
      if (!path || !f) return;
      await get().setViewed(path, !isViewed(get(), f));
    },
    setCollapsedAtCursor(collapsed) {
      const path = get().activePath;
      if (!path) return;
      set((s) => ({ collapsed: { ...s.collapsed, [path]: collapsed } }));
      if (collapsed) afterCollapse(path);
      else void get().loadPatch(path);
    },
    setAllCollapsed(collapsed) {
      const paths = get().snapshot?.changed.map((f) => f.path) ?? [];
      const next: Record<string, boolean> = {};
      for (const p of paths) next[p] = collapsed;
      set({ collapsed: next });
    },
    /** Closes the topmost transient thing, innermost first; with nothing open, drops the selection. */
    escape() {
      const s = get();
      if (s.helpOpen) set({ helpOpen: false });
      else if (s.modeMenuOpen) set({ modeMenuOpen: false });
      else if (s.hover) s.closeHover();
      else if (s.symbolMenu) s.closeSymbolMenu();
      else if (s.references.open) s.closeReferences();
      else if (s.symbols.open) s.closeSymbols();
      else if (s.search.open) s.closeSearch();
      else if (s.editingId) s.setEditingId(null);
      else if (s.replyTo) s.closeReply();
      else if (s.draft) s.closeDraft();
      else if (s.visualAnchor) set({ visualAnchor: null });
      else set({ selection: null });
    },
    diffStyle: readDiffStyle(),
    setDiffStyle(style) {
      try {
        localStorage.setItem(DIFF_STYLE_KEY, style);
      } catch {
        /* ignore */
      }
      // The cursor survives the re-layout; its line goes back to the gaze point, since row heights change.
      set((s) => ({
        diffStyle: style,
        draft: null,
        visualAnchor: null,
        ...(s.selection ? { scrollTarget: cursorTarget(s, 'eye') } : {}),
      }));
    },
    snapshot: null,
    error: null,
    threads: [],
    showResolved: false,
    setShowResolved(on) {
      set({ showResolved: on });
    },
    viewed: [],
    config: DEFAULT_USER_CONFIG,
    fileView: null,
    loaded: {},
    gens: {},
    contents: {},
    collapsed: {},
    selection: null,
    draft: null,
    activePath: null,
    scrollTarget: null,
    reveal: null,
    revealed: {},
    addRevealed(id, start, end) {
      set((s) => {
        const path = pathFromItemId(id);
        // Ranges from an older generation of the same file describe a renderer that no longer exists.
        const kept = Object.fromEntries(
          Object.entries(s.revealed).filter(([k]) => k === id || pathFromItemId(k) !== path),
        );
        return { revealed: { ...kept, [id]: [...(kept[id] ?? []), [start, end] as LineRange] } };
      });
    },

    async boot() {
      const g = beginMode();
      // A resync may talk to a restarted server whose versions began again at 1.
      resyncing = true;
      fetching = 0;
      try {
        // The language server is optional; its status failing must not take the review down.
        const lspStatus = api.lspStatus().catch((): LspStatus => ({ enabled: false, servers: [], missing: [] }));
        const tc = configSeq.start();
        const [snap, lists, config, lsp] = await Promise.all([api.snapshot(), fetchLists(), api.config(), lspStatus]);
        // Mode-independent, and nothing else fetches them: a pushed refresh that overtook this
        // boot must not leave them at their defaults for the session.
        set({ lsp });
        if (configSeq.latest(tc)) set({ config });
        await commitSnapshot(snap, g, lists);
      } catch (e) {
        if (current(g)) set({ error: errorMessage(e) });
      }
    },

    async refreshSnapshot(version) {
      if (version != null) {
        if (accounted(version)) return;
        fetching = version;
      }
      const g = begin();
      try {
        const [snap, lists] = await Promise.all([api.snapshot(), fetchLists()]);
        await commitSnapshot(snap, g, lists);
      } catch (e) {
        if (current(g)) set({ error: errorMessage(e) });
      } finally {
        if (fetching === version) fetching = 0;
      }
    },

    // Pushed refreshes carry the token of the transition they were issued in, so a
    // fetch that raced a mode switch cannot show the previous mode's data; the sequence
    // keeps two refreshes of one transition from committing in the wrong order.
    async refreshThreads() {
      const g = generation;
      const t = threadsSeq.start();
      try {
        const threads = await api.threads();
        if (current(g) && threadsSeq.latest(t)) acceptThreads(threads);
      } catch (e) {
        if (current(g) && threadsSeq.latest(t)) report('Loading threads', e);
      }
    },

    async refreshViewed() {
      const g = generation;
      const t = viewedSeq.start();
      try {
        const viewed = await api.viewed();
        if (current(g) && viewedSeq.latest(t)) set({ viewed });
      } catch (e) {
        if (current(g) && viewedSeq.latest(t)) report('Loading viewed marks', e);
      }
    },

    async refreshConfig() {
      const t = configSeq.start();
      try {
        const config = await api.config();
        if (configSeq.latest(t)) set({ config });
      } catch (e) {
        if (configSeq.latest(t)) report('Loading config', e);
      }
    },

    async switchMode(req) {
      const g = beginMode();
      set({ error: null });
      let snap: Snapshot | undefined;
      // Only a fetch this call started is its to release: the version may already be a push's in flight.
      let owned = false;
      try {
        snap = await api.switchMode(req);
        // The pushed refresh normally owns this version already; only a client without a socket gets here.
        if (accounted(snap.version) || !current(g)) return;
        fetching = snap.version;
        owned = true;
        await commitSnapshot(snap, g, await fetchLists());
      } catch (e) {
        if (current(g)) set({ error: errorMessage(e) });
      } finally {
        if (owned && snap && fetching === snap.version) fetching = 0;
      }
    },

    loadFile,

    async openFile(path, line, side) {
      const snap = get().snapshot;
      if (!snap) return;
      const changed = snap.changed.some((f) => f.path === path);
      // The file view stays for a new-side line of the file it shows; old-side lines exist only in the diff.
      if (!changed || (get().fileView?.path === path && side !== 'old')) {
        await get().openFullFile(path, line);
        return;
      }
      if (get().fileView) {
        recordJump();
        set({ fileView: null, selection: null, visualAnchor: null, draft: null, focusedThread: null });
      }
      get().jumpTo(path, line, side);
      set({ activePath: path });
    },

    async loadPatch(path) {
      const snap = get().snapshot;
      if (!snap || get().loaded[path]?.kind !== 'oversized') return;
      await loadBatch(snap, [path], generation);
    },

    async openFullFile(path, line) {
      const snap = get().snapshot;
      if (!snap) return;
      if (!snap.tree.includes(path)) {
        get().flash(`${path} no longer exists on this side`);
        return;
      }
      const g = generation;
      if (get().fileView?.path !== path) {
        recordJump();
        await loadFileView(path, g);
        if (!current(g) || get().fileView?.path !== path) return;
      }
      const item = get().fileView?.item;
      if (item?.kind === 'error') get().flash(`Cannot open ${path}: ${item.message}`);
      get().jumpTo(path, line);
      set({ activePath: path });
    },

    closeFullFile() {
      const view = get().fileView;
      if (!view) return;
      recordJump();
      const { position, activePath } = view.from;
      // Point the jumplist at the position we return to, so Ctrl+i re-enters the view.
      const jumps = get().jumps;
      const at = position
        ? jumps.findLastIndex(
            (j) => j.path === position.path && j.line === position.line && j.side === position.side && !j.full,
          )
        : -1;
      set({
        fileView: null,
        selection: null,
        visualAnchor: null,
        draft: null,
        focusedThread: null,
        activePath,
        ...(at >= 0 ? { jumpIndex: at } : {}),
      });
      // Restore the cursor the view was entered from; without one, at least the file that was in view.
      if (position) void goToPositionSilently(position);
      else if (activePath)
        set((s) => ({
          scrollTarget: { id: itemIdOf(s, activePath), align: 'start', nonce: (s.scrollTarget?.nonce ?? 0) + 1 },
        }));
    },

    setSelection(sel) {
      set({ selection: sel, visualAnchor: null, focusedThread: null });
      if (sel == null && get().draft) set({ draft: null });
    },

    async openDraft(sel) {
      const path = pathFromItemId(sel.id);
      set({ draft: { path, selection: sel }, selection: sel, activePath: path, replyTo: null });
    },

    closeDraft() {
      set({ draft: null, selection: null });
    },

    async draftQuote() {
      const d = get().draft;
      if (!d) return '';
      const l = get().loaded[d.path];
      const range = resolveRange(d.selection, l?.kind === 'diff' ? l.fileDiff : undefined);
      const contents = await ensureContents(d.path, range.side);
      return anchorFromRange(d.path, range, contents).quoted;
    },

    // The composer stays open with its text when a post fails; the toast says why.
    async submitDraft(body) {
      const d = get().draft;
      if (!d || !body.trim()) return;
      try {
        const l = get().loaded[d.path];
        const range = resolveRange(d.selection, l?.kind === 'diff' ? l.fileDiff : undefined);
        const contents = await ensureContents(d.path, range.side);
        const anchor = anchorFromRange(d.path, range, contents);
        await api.addThread({ ...anchor, body });
      } catch (e) {
        return report('Posting the comment', e);
      }
      // Keep the cursor on the commented line so `e` / `dd` apply to it.
      const s = d.selection.range;
      set({
        draft: null,
        visualAnchor: null,
        selection: {
          id: d.selection.id,
          range: { start: s.end, side: s.endSide ?? s.side, end: s.end, endSide: s.endSide ?? s.side },
        },
      });
      await get().refreshThreads();
    },

    async submitReply(threadId, body) {
      if (!body.trim()) return;
      try {
        await api.reply(threadId, { body });
      } catch (e) {
        return report('Posting the reply', e);
      }
      if (get().replyTo === threadId) set({ replyTo: null });
      await get().refreshThreads();
    },

    editMessage: (threadId, messageId, body) =>
      mutateThreads('Editing the message', () => api.editMessage(threadId, messageId, body)),
    deleteMessage: (threadId, messageId) =>
      mutateThreads('Deleting the message', () => api.deleteMessage(threadId, messageId)),
    setResolved: (threadId, resolved) =>
      mutateThreads(resolved ? 'Resolving' : 'Reopening', () => api.setResolved(threadId, resolved)),
    deleteThread: (id) => mutateThreads('Deleting the thread', () => api.deleteThread(id)),
    clearThreads: () => mutateThreads('Deleting all threads', () => api.clearThreads()),
    deleteStaleThreads: () => mutateThreads('Deleting stale threads', () => api.deleteStaleThreads()),

    async exportToGithub(threadIds) {
      let res;
      try {
        res = await api.exportToGithub(threadIds ? { threadIds } : {});
      } catch (e) {
        report('Adding to the GitHub review', e);
        return null;
      }
      // Success is shown by the button's own state; only skipped threads need a toast, and
      // an unchanged duplicate is the expected answer to re-exporting, not a warning.
      const worrying = res.skipped.filter((s) => s.reason !== 'already in the review');
      if (worrying.length) {
        const total = res.posted + res.updated + res.skipped.length;
        get().flash(`Skipped ${worrying.length} of ${total} (${worrying.map((s) => s.reason).join(', ')})`);
      }
      return res.posted > 0 ? 'added' : res.updated > 0 ? 'updated' : 'unchanged';
    },

    async setViewed(path, viewed) {
      const f = get().snapshot?.changed.find((x) => x.path === path);
      if (!f) return;
      // Optimistic: flip locally, then persist. Older marks for the path stay so
      // `restale` can still be derived until the server answers.
      set((s) => ({
        viewed: [...s.viewed.filter((v) => !(v.path === path && v.blob === f.blob)), { path, blob: f.blob, viewed }],
        collapsed: { ...s.collapsed, [path]: viewed },
      }));
      if (viewed) afterCollapse(path);
      await persistViewed('Marking viewed', () => api.setViewed(path, f.blob, viewed));
    },

    async unviewAll() {
      const snap = get().snapshot;
      if (!snap) return;
      const entries = snap.changed.map((f) => ({ path: f.path, blob: f.blob, viewed: false }));
      const collapsed: Record<string, boolean> = {};
      for (const f of snap.changed) collapsed[f.path] = false;
      set({ viewed: entries, collapsed });
      await persistViewed('Marking all not viewed', () => api.setViewedBulk(entries));
    },
    toggleCollapsed(path) {
      const cur = isCollapsed(get(), path);
      set((s) => ({ collapsed: { ...s.collapsed, [path]: !cur } }));
      if (!cur) afterCollapse(path);
      else void get().loadPatch(path);
    },

    async saveConfig(config) {
      // Saves run in order, and only the newest config request (save or load) may commit.
      let t = 0;
      try {
        const saved = await configWrites(() => {
          t = configSeq.start();
          return api.saveConfig(config);
        });
        if (configSeq.latest(t)) set({ config: saved });
      } catch (e) {
        if (configSeq.latest(t)) report('Saving settings', e);
      }
    },

    jumpTo(path, line, side) {
      recordJump();
      if (line != null) ensureExpanded(path);
      const id = itemIdOf(get(), path);
      if (line == null) {
        // Opening a file: the cursor lands on its first hunk so ] / [ / n / N continue from there.
        const items = nav();
        const itemIndex = items.findIndex((i) => i.id === id);
        const item = items[itemIndex];
        if (item && !item.collapsed && item.rows.length) {
          const rowIndex = Math.max(
            0,
            item.rows.findIndex((r) => r.hunkStart),
          );
          set({ selection: selectionFor(items, { itemIndex, rowIndex }), visualAnchor: null });
        }
      }
      if (line != null && side !== 'old') {
        // A new-side line folded into collapsed context has no row to scroll to: expand around it first.
        // Deleted lines always sit inside a hunk, so the old side never needs this.
        const item = nav().find((i) => i.id === id);
        const folded =
          item != null &&
          get().loaded[path]?.kind === 'diff' &&
          !item.rows.some((r) => r.side === 'additions' && r.line === line);
        if (folded) {
          set((s) => ({ activePath: path, reveal: { id, path, line, nonce: (s.reveal?.nonce ?? 0) + 1 } }));
          return;
        }
      }
      set((s) => ({
        scrollTarget: { id, line, side, align: line ? 'eye' : 'start', nonce: (s.scrollTarget?.nonce ?? 0) + 1 },
        activePath: path,
      }));
    },

    setActivePath(path) {
      set({ activePath: path });
    },
  };
});

function sameChange(a: ChangedFile, b: ChangedFile): boolean {
  return (
    a.blob === b.blob &&
    a.status === b.status &&
    a.oldPath === b.oldPath &&
    a.additions === b.additions &&
    a.deletions === b.deletions
  );
}

// Dev-only hook: read store state from the console. Not part of the production surface.
declare global {
  interface Window {
    __diffle?: () => ReviewState;
  }
}
if (import.meta.env.DEV && typeof window !== 'undefined') window.__diffle = () => useStore.getState();

/** Run `fn` over `items` with at most `limit` in flight; `stopped()` is consulted before each dequeue. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  stopped: () => boolean,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !stopped()) await fn(items[i++]!);
  });
  await Promise.all(workers);
}
