import { KIND_LABEL } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import type { Size } from '@/client/graph/layout/layout.js';

/** What a node box says: its name, and below it what kind of thing it is. */
export interface NodeLabel {
  title: string;
  detail: string;
}

const MAX_CHARS = 36;
// The box is sized from character counts: a monospace title, a small sans detail line.
const TITLE_CHAR = 7.3;
const DETAIL_CHAR = 6.1;
// The kind icon's column on the left, and the status badge right of the name.
const TITLE_PAD = 56;
const DETAIL_PAD = 34;
export const NODE_H = 40;

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

export function clip(text: string, max = MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** In file mode, or for a use from a file's top level, the node is the file itself. */
export function nodeLabel(node: GraphNode, clustered: boolean): NodeLabel {
  if (node.kind === 1)
    return clustered
      ? { title: 'top level', detail: 'module' }
      : { title: basename(node.path), detail: dirname(node.path) };
  const kind = KIND_LABEL[node.kind] ?? 'symbol';
  return { title: node.name, detail: node.container ? `${kind} · ${node.container}` : kind };
}

export function nodeSize(node: GraphNode, clustered: boolean): Size {
  const { title, detail } = nodeLabel(node, clustered);
  const w = Math.max(clip(title).length * TITLE_CHAR + TITLE_PAD, clip(detail, 44).length * DETAIL_CHAR + DETAIL_PAD);
  return { w: Math.min(320, Math.max(120, Math.ceil(w))), h: NODE_H };
}
