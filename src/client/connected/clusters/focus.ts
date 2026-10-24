import type { GraphContext, GraphResponse, GraphUse } from '@/shared/protocol.js';

// Pure rules for the Connected scope: which files a focus lists, and how the focus moves.
// The server owns the clustering; the client only narrows by the ids it was given.

/** Which file set the tree and the review pane show. */
export type TreeScope = 'changed' | 'all' | 'connected';

/** The group of changed files the review is narrowed to: one cluster, or the two buckets beside the clusters. */
export type Focus = { kind: 'cluster'; id: string } | { kind: 'unlinked' } | { kind: 'other' };

export interface GraphState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: GraphResponse | null;
  error: string | null;
}

export const IDLE_GRAPH: GraphState = { status: 'idle', data: null, error: null };

const UNLINKED: Focus = { kind: 'unlinked' };
const OTHER: Focus = { kind: 'other' };

export function sameFocus(a: Focus | null, b: Focus | null): boolean {
  if (a === null || b === null) return a === b;
  switch (a.kind) {
    case 'cluster':
      return b.kind === 'cluster' && a.id === b.id;
    case 'unlinked':
    case 'other':
      return a.kind === b.kind;
  }
}

/** Every group the reader can focus, in cycling order: clusters, then unlinked, then other; empty groups left out. */
export function focusGroups(graph: GraphResponse): Focus[] {
  return [
    ...graph.clusters.filter((c) => c.files.length > 0).map((c): Focus => ({ kind: 'cluster', id: c.id })),
    ...(graph.unlinked.length > 0 ? [UNLINKED] : []),
    ...(graph.other.length > 0 ? [OTHER] : []),
  ];
}

/** `focus` while its group still exists in `graph`, else the first group. */
export function keptFocus(graph: GraphResponse, focus: Focus | null): Focus | null {
  const groups = focusGroups(graph);
  return groups.find((g) => sameFocus(g, focus)) ?? groups[0] ?? null;
}

/** The group `delta` steps from `focus`, wrapping. From no focus (or one the graph lacks): the first group going forward, the last going back. */
export function moveFocus(graph: GraphResponse, focus: Focus | null, delta: number): Focus | null {
  const groups = focusGroups(graph);
  if (groups.length === 0) return null;
  const at = groups.findIndex((g) => sameFocus(g, focus));
  if (at === -1) return delta > 0 ? groups[0]! : groups[groups.length - 1]!;
  return groups[(((at + delta) % groups.length) + groups.length) % groups.length]!;
}

/** The `n`th cluster (from 1, empty ones skipped, buckets not counted); a count out of range clamps to the nearest end. */
export function clusterAt(graph: GraphResponse | null, n: number): Focus | null {
  const clusters = graph ? focusGroups(graph).filter((g) => g.kind === 'cluster') : [];
  return clusters[Math.min(Math.max(n, 1), clusters.length) - 1] ?? null;
}

/** The group holding `path`, or null when the graph does not know it (a file changed since it was built). */
export function groupOf(graph: GraphResponse | null, path: string): Focus | null {
  if (!graph) return null;
  const cluster = graph.clusters.find((c) => c.files.includes(path));
  if (cluster) return { kind: 'cluster', id: cluster.id };
  if (graph.unlinked.includes(path)) return UNLINKED;
  return graph.other.includes(path) ? OTHER : null;
}

/**
 * The changed files the review lists for `focus`. `changed` is every changed file in tree order, which this
 * keeps: a group's files are narrowed out of it, so a member that stopped being changed drops out. A null
 * focus, a focus `graph` does not know, or a group with no changed file left (a stale graph) lists everything.
 */
export function listing(changed: readonly string[], graph: GraphResponse | null, focus: Focus | null): string[] {
  const members = graph && focus && groupFiles(graph, focus);
  if (!members) return [...changed];
  const set = new Set(members);
  const narrowed = changed.filter((p) => set.has(p));
  return narrowed.length > 0 ? narrowed : [...changed];
}

function groupFiles(graph: GraphResponse, focus: Focus): readonly string[] | undefined {
  switch (focus.kind) {
    case 'cluster':
      return graph.clusters.find((c) => c.id === focus.id)?.files;
    case 'unlinked':
      return graph.unlinked;
    case 'other':
      return graph.other;
  }
}

/**
 * The unchanged callers the review lists after the changed files: the focused cluster's, most references
 * first, while `on`. The one rule for the tree and the pane; it never names a file that is changed now, so
 * an older graph cannot list a file twice.
 */
export function callers(
  changed: ReadonlySet<string>,
  graph: GraphResponse | null,
  focus: Focus | null,
  on: boolean,
): readonly GraphContext[] {
  if (!on) return NO_CALLERS;
  const entries = contextOf(graph, focus);
  return entries.length === 0 ? NO_CALLERS : entries.filter((c) => !changed.has(c.path));
}

const NO_CALLERS: readonly GraphContext[] = [];

/** Whether `+ context` has anything to list: the focus is a cluster the server found unchanged callers for. */
export function canListContext(graph: GraphResponse | null, focus: Focus | null): boolean {
  if (!graph || focus?.kind !== 'cluster') return false;
  return (graph.clusters.find((c) => c.id === focus.id)?.contextTotal ?? 0) > 0;
}

/** The unchanged callers the focused cluster has, most references first; none for any other group. */
export function contextOf(graph: GraphResponse | null, focus: Focus | null): readonly GraphContext[] {
  if (!graph || focus?.kind !== 'cluster') return [];
  return graph.clusters.find((c) => c.id === focus.id)?.context ?? [];
}

/** The lines of `uses`, ascending and without repeats. */
export const useLines = (uses: readonly GraphUse[]): number[] =>
  [...new Set(uses.flatMap((u) => u.lines))].sort((a, b) => a - b);

const linkLinesCache = new WeakMap<GraphContext, readonly number[]>();

/**
 * Where `entry` uses the cluster, ascending, as the stops `]` / `[` visit in its file. One list per
 * entry, so the rows built from it stay cached while the graph is the same object.
 */
export function linkLines(entry: GraphContext): readonly number[] {
  let lines = linkLinesCache.get(entry);
  if (!lines) {
    lines = useLines(entry.uses);
    linkLinesCache.set(entry, lines);
  }
  return lines;
}
