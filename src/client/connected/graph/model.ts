import type { GraphCluster, GraphContext, GraphUse } from '@/shared/protocol.js';
import type { GraphState } from '@/client/connected/clusters/focus.js';
import { isTestPath } from '@/client/connected/clusters/testPath.js';

export type NodeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'context';

export interface GraphNode {
  /** The file's path. */
  id: string;
  name: string;
  dir: string;
  status: NodeStatus;
  add: number;
  del: number;
  /** Distinct files it uses. */
  out: number;
  /** Distinct files using it. */
  in: number;
  /** A test file by its path: drawn as secondary, and hidden on request. */
  test: boolean;
}

export interface GraphEdge {
  /** `${from}\u0000${to}`. */
  id: string;
  from: string;
  to: string;
  weight: number;
  uses: GraphUse[];
  total: number;
  /** Drawn only because `+ context` is on: the caller is an unchanged file. */
  context: boolean;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Changed files and links the cluster has once hidden tests are set aside: what the counts line reports. */
  files: number;
  links: number;
  /** Changed files left out by the node cap. */
  hiddenFiles: number;
  /** Changed-file links the server left out or the node cap dropped. */
  hiddenLinks: number;
  /** Test files (changed files and unchanged callers) left out on request. */
  hiddenTests: number;
}

/** What the model needs to know of a changed file; a `ChangedFile` fits. */
export interface FileFacts {
  status: string;
  additions: number;
  deletions: number;
}

/** Changed-file nodes drawn at most; the layout and the SVG stay readable and fast. */
export const MAX_NODES = 60;

const STATUS_OF: Record<string, NodeStatus> = { A: 'added', D: 'deleted', R: 'renamed' };

// Code-unit order, not locale order, so the model is the same on every machine.
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const edgeId = (from: string, to: string): string => `${from}\u0000${to}`;

function split(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/** The changed-file links whose both ends are changed files of the cluster, one per `from`/`to`. */
function candidateEdges(cluster: GraphCluster, changed: Set<string>): GraphEdge[] {
  const edges = new Map<string, GraphEdge>();
  for (const l of cluster.links) {
    if (!changed.has(l.from) || !changed.has(l.to)) continue;
    const id = edgeId(l.from, l.to);
    if (!edges.has(id))
      edges.set(id, { id, from: l.from, to: l.to, weight: l.weight, uses: l.uses, total: l.total, context: false });
  }
  return [...edges.values()];
}

/** The `MAX_NODES` changed files with the most incident edges, then the smallest paths. */
function keepChanged(files: string[], edges: GraphEdge[]): Set<string> {
  const degree = new Map<string, number>(files.map((f) => [f, 0]));
  for (const e of edges) {
    degree.set(e.from, degree.get(e.from)! + 1);
    degree.set(e.to, degree.get(e.to)! + 1);
  }
  const ranked = [...files].sort((a, b) => degree.get(b)! - degree.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  return new Set(ranked.slice(0, MAX_NODES));
}

/** One edge per (caller, used file): the caller's uses grouped by the file declaring the symbol. */
function contextEdges(cluster: GraphCluster, kept: Set<string>, callers: GraphContext[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const caller of callers) {
    const groups = new Map<string, GraphUse[]>();
    for (const u of caller.uses) {
      if (!kept.has(u.path)) continue;
      groups.set(u.path, [...(groups.get(u.path) ?? []), u]);
    }
    for (const [to, uses] of groups) {
      edges.push({
        id: edgeId(caller.path, to),
        from: caller.path,
        to,
        weight: uses.length,
        uses,
        total: uses.length,
        context: true,
      });
    }
  }
  return edges;
}

/**
 * The drawable model of one cluster: its changed files (at most `MAX_NODES`, best connected first),
 * plus, when `context` is on, its unchanged callers. `hideTests` takes the test files out first, with their
 * arrows, so the node cap is spent on source. Nodes and edges come sorted by id, so the model, and the layout
 * built on it, do not depend on the order the server listed things in.
 */
export function buildGraphModel(
  cluster: GraphCluster,
  fileOf: (path: string) => FileFacts | undefined,
  context: boolean,
  hideTests = false,
): GraphModel {
  const changed = new Set(cluster.files);
  const candidates = candidateEdges(cluster, changed);
  const shown = (path: string): boolean => !hideTests || !isTestPath(path);
  const all = candidates.filter((e) => shown(e.from) && shown(e.to));
  const keptFiles = keepChanged([...changed].filter(shown), all);
  const fileEdges = all.filter((e) => keptFiles.has(e.from) && keptFiles.has(e.to));
  const callers = cluster.context.filter((c) => !changed.has(c.path) && shown(c.path));
  const ctxEdges = context ? contextEdges(cluster, keptFiles, callers) : [];
  const edges = [...fileEdges, ...ctxEdges].sort(byId);

  const out = new Map<string, number>();
  const into = new Map<string, number>();
  for (const e of edges) {
    out.set(e.from, (out.get(e.from) ?? 0) + 1);
    into.set(e.to, (into.get(e.to) ?? 0) + 1);
  }
  const node = (id: string, status: NodeStatus, add: number, del: number): GraphNode => ({
    id,
    ...split(id),
    status,
    add,
    del,
    out: out.get(id) ?? 0,
    in: into.get(id) ?? 0,
    test: isTestPath(id),
  });

  const nodes = [...keptFiles].map((path) => {
    const f = fileOf(path);
    return node(path, f ? (STATUS_OF[f.status] ?? 'modified') : 'modified', f?.additions ?? 0, f?.deletions ?? 0);
  });
  if (context) for (const c of callers) nodes.push(node(c.path, 'context', 0, 0));
  const testFiles = hideTests ? [...changed].filter(isTestPath).length : 0;
  const testCallers =
    hideTests && context ? cluster.context.filter((c) => !changed.has(c.path) && isTestPath(c.path)).length : 0;
  // Arrows that went with the tests are not "left out": the reader asked for them gone.
  const withTests = hideTests ? candidates.length - all.length : 0;
  return {
    nodes: nodes.sort(byId),
    edges,
    files: changed.size - testFiles,
    links: Math.max(0, cluster.linksTotal - withTests),
    hiddenFiles: changed.size - testFiles - keptFiles.size,
    hiddenLinks: Math.max(0, cluster.linksTotal - fileEdges.length - withTests),
    hiddenTests: testFiles + testCallers,
  };
}

/** Whether the store is still fetching the graph, or holds one older than the snapshot: not the time to rebuild. */
export const graphPending = (graph: GraphState, version: number | undefined): boolean =>
  graph.status === 'loading' || (graph.data !== null && graph.data.version !== version);
