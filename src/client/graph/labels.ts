import { KIND_LABEL } from '@/client/lsp/symbolKind.js';
import type { GraphNode } from '@/shared/protocol.js';
import type { Size } from '@/client/graph/layout/layout.js';

/**
 * What a node box says: its name, and below it what kind of thing it is (`kind`) and where it sits
 * (`code`: the class holding it, or a file's folder), the code part in monospace. Either may be empty.
 */
export interface NodeLabel {
  title: string;
  kind: string;
  code: string;
}

const MAX_CHARS = 36;
// The box is sized from character counts: a monospace title, a small sans kind and monospace code under it.
export const TITLE_CHAR = 7.3;
export const KIND_CHAR = 6.1;
export const CODE_CHAR = 6.4;
/** Between the kind and the code: " · ". */
export const SEPARATOR_W = 12;
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
      ? { title: 'top level', kind: 'module', code: '' }
      : { title: basename(node.path), kind: '', code: dirname(node.path) };
  return { title: node.name, kind: KIND_LABEL[node.kind] ?? 'symbol', code: node.container ?? '' };
}

export function nodeSize(node: GraphNode, clustered: boolean): Size {
  const { title, kind, code } = nodeLabel(node, clustered);
  const detail = kind.length * KIND_CHAR + (kind && code ? SEPARATOR_W : 0) + clip(code, 30).length * CODE_CHAR;
  const w = Math.max(clip(title).length * TITLE_CHAR + TITLE_PAD, detail + DETAIL_PAD);
  return { w: Math.min(320, Math.max(120, Math.ceil(w))), h: NODE_H };
}
