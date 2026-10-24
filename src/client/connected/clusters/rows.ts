import type { GraphCluster, GraphResponse } from '@/shared/protocol.js';
import { BUCKET_HINT, plural } from './copy.js';
import { ROOT_LABEL, clusterTitle } from './clusterTitle.js';
import { callers, focusGroups, listing, sameFocus, type Focus, type TreeScope } from './focus.js';

/** Member paths the hover title names before the rest fold into a count. */
const MEMBERS_NAMED = 5;

export interface ClusterRow {
  focus: Focus;
  /** 1-based position among the clusters; null on the Unlinked and Other buckets. */
  index: number | null;
  /** The cluster's title (the file its arrows point at), or the bucket's name and size. */
  label: string;
  /** The cluster's shared directory, as the secondary text; null on a bucket, or when it is the title itself. */
  folder: string | null;
  /** Changed files in the cluster; null on a bucket, whose label already carries its size. */
  count: number | null;
  /** Unchanged callers the cluster has before the server's cap; 0 on a bucket. */
  context: number;
  /** Unchanged callers the server listed (at most its cap). */
  listed: number;
  /** What a bucket holds, shown while it is focused; null on a cluster. */
  hint: string | null;
  /** Hover text with the row's full detail. */
  title: string;
  ariaLabel: string;
  focused: boolean;
}

/** One row per focusable group, in the order `gt` cycles through them. */
export function clusterRows(graph: GraphResponse, focus: Focus | null): ClusterRow[] {
  let index = 0;
  return focusGroups(graph).map((group): ClusterRow => {
    const focused = sameFocus(group, focus);
    switch (group.kind) {
      case 'cluster':
        return clusterRow(
          graph.clusters.find((x) => x.id === group.id)!,
          ++index,
          focused,
        );
      case 'unlinked':
        return bucketRow(group, `Unlinked (${graph.unlinked.length})`, BUCKET_HINT.unlinked, focused);
      case 'other':
        return bucketRow(group, `Other (${graph.other.length})`, BUCKET_HINT.other, focused);
    }
  });
}

function clusterRow(c: GraphCluster, index: number, focused: boolean): ClusterRow {
  const label = clusterTitle(c);
  const folder = c.label || ROOT_LABEL;
  const files = plural(c.files.length, 'changed file');
  const callersText = plural(c.contextTotal, 'unchanged caller');
  const named = c.files.slice(0, MEMBERS_NAMED);
  const folded = c.files.length - named.length;
  return {
    focus: { kind: 'cluster', id: c.id },
    index,
    label,
    folder: folder === label ? null : folder,
    count: c.files.length,
    context: c.contextTotal,
    listed: c.context.length,
    hint: null,
    title: [
      label,
      ...(folder === label ? [] : [folder]),
      `${files} · ${plural(c.symbols, 'symbol')} · ${callersText}`,
      ...named,
      ...(folded > 0 ? [`+${folded} more`] : []),
    ].join('\n'),
    ariaLabel: `${label}, ${folder === label ? '' : `in ${folder}, `}${files}, ${callersText}`,
    focused,
  };
}

function bucketRow(focus: Focus, label: string, hint: string, focused: boolean): ClusterRow {
  return {
    focus,
    index: null,
    label,
    folder: null,
    count: null,
    context: 0,
    listed: 0,
    hint,
    title: hint,
    ariaLabel: label,
    focused,
  };
}

export interface ScopeInputs {
  scope: TreeScope;
  /** Every changed file in tree order. */
  changed: readonly string[];
  /** Every file of the new side. */
  tree: readonly string[];
  graph: GraphResponse | null;
  focus: Focus | null;
  /** Whether the focused cluster's unchanged callers are listed too. */
  context: boolean;
}

/** The paths the file tree lists. Connected narrows to the focus, with the review pane's own callers; without a graph it lists every changed file. */
export function scopePaths({ scope, changed, tree, graph, focus, context }: ScopeInputs): string[] {
  switch (scope) {
    case 'changed':
      return [...changed];
    case 'all':
      return [...tree];
    case 'connected':
      return [
        ...listing(changed, graph, focus),
        ...callers(new Set(changed), graph, focus, context).map((c) => c.path),
      ];
  }
}
