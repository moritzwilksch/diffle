import { type Match, useStore } from '@/client/store.js';
import type { GraphNode } from '@/shared/protocol.js';
import { basename } from '@/client/graph/labels.js';

/** One entry of the panel's links: the node at the other end, and the lines of `path` that make the link. */
export interface PeekEntry {
  node: GraphNode;
  path: string;
  lines: number[];
}

const nameOf = (node: GraphNode) => (node.kind === 1 ? node.path : node.name);

/**
 * Opens the references list on `of`'s links, entry by entry as the panel lists them, so Space
 * peeks through them in context without leaving the graph.
 */
export async function peekLinks(kind: 'references' | 'uses', of: GraphNode, entries: PeekEntry[]): Promise<void> {
  const store = useStore.getState();
  const snapshot = store.snapshot;
  const paths = [...new Set(entries.map((e) => e.path))];
  let files: string[][];
  try {
    files = (await Promise.all(paths.map((p) => store.loadFile(p, 'new')))).map((f) => f.contents.split('\n'));
  } catch (e) {
    return store.flash(`Loading the links failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A refresh since the click would list lines of the old snapshot.
  if (useStore.getState().snapshot !== snapshot) return;
  const text = new Map(paths.map((p, i) => [p, files[i]!]));
  const items: Match[] = entries.flatMap(({ node, path, lines }) =>
    [...lines]
      .sort((a, b) => a - b)
      .map((line) => ({
        path,
        line,
        text: text.get(path)?.[line - 1] ?? '',
        under: { name: nameOf(node), kind: node.kind },
      })),
  );
  useStore.getState().showReferences({ kind, symbol: of.kind === 1 ? basename(of.path) : of.name, items });
}
