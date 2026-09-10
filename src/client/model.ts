import picomatch from 'picomatch/posix';
import type {
  ChangedFile,
  CommentThread,
  LspSymbol,
  ModeRequest,
  SearchScope,
  Snapshot,
  UserConfig,
  ViewedState,
} from '../shared/protocol.js';
import type { ReviewState } from './store.js';

// Pure functions over store state. No effects, no store import at runtime, so
// every module (the store included) can use them without a cycle.

/**
 * CodeView item id: kind, path, and content generation. The generation is part
 * of the id so a reloaded diff gets a fresh renderer instead of being patched
 * into a stale one.
 */
export function itemId(changed: boolean, path: string, gen: number): string {
  return `${changed ? 'diff' : 'file'}:${path}@${gen}`;
}

export function pathFromItemId(id: string): string {
  return id.replace(/^(diff|file):/, '').replace(/@\d+$/, '');
}

/** The id of the item that shows `path` right now: its whole-file item while the file view is open on it, else its diff. */
export function itemIdOf(state: Pick<ReviewState, 'snapshot' | 'gens' | 'fileView'>, path: string): string {
  const changed = state.fileView?.path !== path && (state.snapshot?.changed.some((f) => f.path === path) ?? false);
  return itemId(changed, path, state.gens[path] ?? 0);
}

/** Most changed files a patch request carries. */
export const PATCH_BATCH_FILES = 12;
/** Most changed lines (additions + deletions) a patch request carries; a single larger file rides alone. */
export const PATCH_BATCH_LINES = 4000;
/** A diff past this many changed lines is not loaded until asked for: parsing it would stall the review. */
export const OVERSIZED_LINES = 10_000;

export const linesOf = (f: ChangedFile): number => f.additions + f.deletions;

/**
 * Splits the textual files to load into request batches, first-needed first: `first` (the file
 * the reader is on), then expanded files in list order, collapsed ones last; within each tier a
 * file too big for a shared batch sinks below the rest, so a lockfile never delays a source file.
 * Each batch stays within PATCH_BATCH_FILES and PATCH_BATCH_LINES.
 */
export function patchBatches(
  snapshot: Snapshot,
  files: ChangedFile[],
  first: string[],
  isCollapsed: (path: string) => boolean,
): string[][] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const rank = (p: string) =>
    first.includes(p) ? 0 : (isCollapsed(p) ? 4 : 2) + (linesOf(byPath.get(p)!) > PATCH_BATCH_LINES ? 1 : 0);
  const order = orderedPaths(snapshot)
    .filter((p) => byPath.has(p))
    .sort((a, b) => rank(a) - rank(b));
  const batches: string[][] = [];
  let batch: string[] = [];
  let lines = 0;
  for (const p of order) {
    const n = linesOf(byPath.get(p)!);
    if (batch.length > 0 && (batch.length >= PATCH_BATCH_FILES || lines + n > PATCH_BATCH_LINES)) {
      batches.push(batch);
      batch = [];
      lines = 0;
    }
    batch.push(p);
    lines += n;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** Changed files in the order the file tree pane shows them: the order the review pane and the cursor share. */
export function orderedPaths(snapshot: Snapshot): string[] {
  return snapshot.changed.map((f) => f.path).sort(compareTreeOrder);
}

/**
 * The file the reader is in: the one the cursor landed on, else the open whole-file view,
 * else the first file in the list, which is the one in view before the cursor has landed anywhere.
 */
export function currentPath(state: Pick<ReviewState, 'snapshot' | 'activePath' | 'fileView'>): string | null {
  return state.activePath ?? state.fileView?.path ?? (state.snapshot && orderedPaths(state.snapshot)[0]) ?? null;
}

/** The search scopes in widening order; the search bar's scope button cycles through them. */
export const SEARCH_SCOPES: readonly SearchScope[] = ['file', 'diff', 'repo'];

export function nextSearchScope(scope: SearchScope): SearchScope {
  return SEARCH_SCOPES[(SEARCH_SCOPES.indexOf(scope) + 1) % SEARCH_SCOPES.length]!;
}

/** `g/` widens a file-scoped search to the diff but keeps a codebase-wide choice. */
export function widenSearchScope(scope: SearchScope): Exclude<SearchScope, 'file'> {
  return scope === 'file' ? 'diff' : scope;
}

/**
 * The order `@pierre/trees` lists paths in (its path store's default sort), so the review pane and
 * the tree agree file for file: at the first segment where two paths diverge, folders before
 * files, then the lowercased segments compared naturally (digit runs as numbers, the rest by code
 * unit), ties broken by the raw segment; a path that is a prefix of another comes first. A segment
 * is a folder when it is not the path's last one, so the answer depends only on the two paths.
 */
export function compareTreeOrder(a: string, b: string): number {
  const sa = a.split('/');
  const sb = b.split('/');
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i]!;
    const y = sb[i]!;
    if (x === y) continue;
    const aDir = i < sa.length - 1;
    const bDir = i < sb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    const lx = x.toLowerCase();
    const ly = y.toLowerCase();
    const natural = compareNatural(lx, ly);
    if (natural !== 0) return natural;
    if (lx !== ly) return lx < ly ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return sa.length - sb.length;
}

/** Digit runs compare as numbers, everything else by code unit; fewer tokens first on a shared prefix. */
function compareNatural(a: string, b: string): number {
  const ta = naturalTokens(a);
  const tb = naturalTokens(b);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i]!;
    const y = tb[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    const sx = String(x);
    const sy = String(y);
    if (sx !== sy) return sx < sy ? -1 : 1;
  }
  return ta.length - tb.length;
}

function naturalTokens(value: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  const re = /\d+|\D+/g;
  for (const m of value.matchAll(re)) tokens.push(/^\d/.test(m[0]) ? Number(m[0]) : m[0]);
  if (tokens.length === 0) tokens.push('');
  return tokens;
}

/**
 * Explicit mark at the current blob wins. Otherwise a viewed mark at an older
 * blob means the file changed after sign-off ('restale'); else the auto-viewed
 * patterns decide.
 */
export function viewedState(state: Pick<ReviewState, 'viewed' | 'config'>, file: ChangedFile): ViewedState {
  const explicit = state.viewed.find((v) => v.path === file.path && v.blob === file.blob);
  if (explicit) return explicit.viewed ? 'viewed' : 'unviewed';
  if (state.viewed.some((v) => v.path === file.path && v.viewed && v.blob !== file.blob)) return 'restale';
  return matchesAutoViewed(state.config, file.path) ? 'viewed' : 'unviewed';
}

export function isViewed(state: Pick<ReviewState, 'viewed' | 'config'>, file: ChangedFile): boolean {
  return viewedState(state, file) === 'viewed';
}

/** Number of changed files currently viewed (explicit marks and auto-viewed patterns; restale does not count). */
export function countViewed(state: Pick<ReviewState, 'viewed' | 'config'>, changed: readonly ChangedFile[]): number {
  let n = 0;
  for (const f of changed) if (isViewed(state, f)) n++;
  return n;
}

/** Collapsed defaults to viewed or generated, until the user toggles it. */
export function isCollapsed(
  state: Pick<ReviewState, 'collapsed' | 'viewed' | 'config' | 'snapshot'>,
  path: string,
): boolean {
  const explicit = state.collapsed[path];
  if (explicit != null) return explicit;
  const f = state.snapshot?.changed.find((x) => x.path === path);
  return f ? isViewed(state, f) || f.generated : false;
}

/** Threads the UI shows: open ones, plus resolved when the user asked for them. */
export function visibleThreads(state: Pick<ReviewState, 'threads' | 'showResolved'>): CommentThread[] {
  return state.showResolved ? state.threads : state.threads.filter((t) => !t.resolved);
}

export function threadOfMessage(threads: CommentThread[], messageId: string): CommentThread | undefined {
  return threads.find((t) => t.messages.some((m) => m.id === messageId));
}

/**
 * A fetched thread list with every thread whose content did not change kept as the object
 * already in the store, so per-path render keys and memoized cards see it as unchanged.
 */
export function reuseThreads(prev: CommentThread[], next: CommentThread[]): CommentThread[] {
  if (prev === next) return next;
  const byId = new Map(prev.map((t) => [t.id, t]));
  let same = prev.length === next.length;
  const out = next.map((t, i) => {
    const was = byId.get(t.id);
    const kept = was && JSON.stringify(was) === JSON.stringify(t) ? was : t;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}

/** Everything CodeView paints for `path` beyond its content; comparable by identity, see `itemVersion`. */
export function itemDeps(
  state: Pick<ReviewState, 'draft' | 'replyTo' | 'editingId'>,
  path: string,
  mine: CommentThread[],
  collapsed: boolean,
): unknown[] {
  const reply = state.replyTo != null && mine.some((t) => t.id === state.replyTo) ? state.replyTo : null;
  const editing = state.editingId != null && threadOfMessage(mine, state.editingId) ? state.editingId : null;
  return [...mine, state.draft?.path === path ? state.draft : null, collapsed, reply, editing];
}

export interface ItemVersion {
  deps: unknown[];
  version: number;
}

/**
 * The version an item carries: CodeView re-renders an item only when its version changed, so
 * it is derived from the render deps rather than bumped by hand. Same deps, same version.
 */
export function itemVersion(prev: ItemVersion | undefined, deps: unknown[]): ItemVersion {
  if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) return prev;
  return { deps, version: (prev?.version ?? 0) + 1 };
}

const matcherCache = new Map<string, (p: string) => boolean>();
function matchesAutoViewed(config: UserConfig, path: string): boolean {
  const key = config.autoViewed.join('\n');
  let m = matcherCache.get(key);
  if (!m) {
    const patterns = config.autoViewed.filter(Boolean);
    m = patterns.length ? picomatch(patterns, { dot: true, basename: true }) : () => false;
    matcherCache.set(key, m);
  }
  return m(path);
}

/** Case-insensitive match on the symbol name: prefix matches first, then substring, then subsequence. */
export function filterSymbols(all: LspSymbol[], query: string): LspSymbol[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  const scored: [number, LspSymbol][] = [];
  for (const s of all) {
    const name = s.name.toLowerCase();
    if (name.startsWith(q)) scored.push([0, s]);
    else if (name.includes(q)) scored.push([1, s]);
    else if (isSubsequence(q, name)) scored.push([2, s]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return false;
}

/** Compare two validated, nonnegative ancestor offsets from HEAD. */
export function lastCommitsRequest(n: number, m: number): ModeRequest {
  return { kind: 'revspec', args: [`HEAD~${n}..HEAD~${m}`] };
}

/**
 * Whether a snapshot can join a pending GitHub review. GitHub anchors a comment to a
 * commit, so the new side must be the checked-out commit; the worktree has no commit.
 */
export function canExportToGithub(snapshot: Snapshot | null): boolean {
  return snapshot != null && snapshot.newSha !== 'worktree' && snapshot.newSha === snapshot.headSha;
}

/** What an export did to the pending review: new comments, bodies rewritten in place, or nothing left to do. */
export type ExportOutcome = 'added' | 'updated' | 'unchanged';

/** The green suffix the export button shows afterwards. */
export function exportLabel(outcome: ExportOutcome): string {
  return outcome === 'updated' ? 'Updated' : outcome === 'unchanged' ? 'Already added' : 'Added';
}

/** What names the review: the pull request's base repository, else the root directory. */
export function repoName(snapshot: Snapshot): string {
  if (snapshot.mode.pullRequest) return snapshot.mode.pullRequest.repository;
  const parts = snapshot.root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? snapshot.root;
}

/** Browser tab title; the PR number tells tabs of one repository apart. */
export function documentTitle(snapshot: Snapshot | null): string {
  if (!snapshot) return 'diffle';
  const pr = snapshot.mode.pullRequest;
  return pr ? `diffle: ${repoName(snapshot)} #${pr.number}` : `diffle: ${repoName(snapshot)}`;
}
