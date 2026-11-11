import type { CommentAnchor, CommentThread, TourAnchor } from '@/shared/protocol.js';

/** The file a thread is on; null for one on the tour. */
export function anchorPath(anchor: CommentAnchor): string | null {
  return anchor.kind === 'tour' ? null : anchor.path;
}

/**
 * Review order, as the prompt has it: code threads by path, then line with the file thread first;
 * then the tour's in document order; then by when each was opened.
 */
export function compareThreads(a: CommentThread, b: CommentThread): number {
  return comparePlaces(a.anchor, b.anchor) || (a.messages[0]?.createdAt ?? 0) - (b.messages[0]?.createdAt ?? 0);
}

function comparePlaces(a: CommentAnchor, b: CommentAnchor): number {
  if (a.kind === 'tour' || b.kind === 'tour') {
    if (a.kind !== 'tour') return -1;
    if (b.kind !== 'tour') return 1;
    return compareNodes(a.node, b.node);
  }
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  const line = (x: CommentAnchor) => (x.kind === 'line' ? x.startLine : 0);
  return line(a) - line(b);
}

/** Document order of two places in the tour. */
export function compareNodes(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** What a tour element is to a reader, by the tag its anchor names. */
const KINDS: Record<string, string> = {
  rect: 'box',
  text: 'label',
  'diffle-card': 'card',
  'diffle-diff': 'diff',
  'diffle-code': 'code',
  'diffle-tree': 'tree',
  'diffle-callout': 'callout',
  'diffle-diagram': 'diagram',
  table: 'table',
};

/** A tour thread's header: the words it is on, or the element by its kind and label. */
export function tourLabel(a: TourAnchor): string {
  if (a.target.on === 'text') return `"${cut(a.target.quoted)}"`;
  const tag = (a.element.split(' > ').pop() ?? '').replace(/^</, '').split(/[ >]/)[0] ?? '';
  const kind = KINDS[tag] ?? 'element';
  return a.target.label ? `${kind} "${cut(a.target.label)}"` : kind;
}

function cut(text: string): string {
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
