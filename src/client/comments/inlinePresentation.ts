import type { CodeViewItem, DiffLineAnnotation, LineAnnotation } from '@pierre/diffs';
import type { Annot } from '@/client/review/ReviewPane.js';
import type { Side } from '@/shared/side.js';
import { githubThreadKey, localThreadKey } from './inlineExpansion.js';
import type { LineThreadMarker } from './ThreadMarker.js';

export type InlineThread = Extract<Annot, { kind: 'thread' | 'github' }>;

function position(thread: InlineThread) {
  if (thread.kind === 'github') {
    const { inline } = thread;
    return {
      key: githubThreadKey(inline.thread.id),
      resolved: inline.thread.isResolved,
      origin: 'GitHub',
      line: inline.line,
      side: inline.thread.diffSide === 'LEFT' ? 'old' : 'new',
    } as const;
  }
  const { anchor } = thread.thread;
  return {
    key: localThreadKey(thread.thread.id),
    resolved: thread.thread.resolved,
    origin: 'local',
    line: anchor.kind === 'line' ? anchor.endLine : null,
    side: anchor.kind === 'line' ? anchor.side : 'new',
  } as const;
}

function renderableLine(item: CodeViewItem<Annot>, line: number | null, side: Side, fileLines: number): number {
  if (line == null) return 0;
  if (item.type === 'file') return side === 'new' && line <= fileLines ? line : 0;
  return item.fileDiff.hunks.some((hunk) => {
    const [start, count] =
      side === 'old' ? [hunk.deletionStart, hunk.deletionCount] : [hunk.additionStart, hunk.additionCount];
    return line >= start && line < start + count;
  })
    ? line
    : 0;
}

/** Unified context has just one cell, numbered on the new side. */
function unifiedContextLine(item: CodeViewItem<Annot>, oldLine: number): number | null {
  if (item.type !== 'diff') return null;
  const hunk = item.fileDiff.hunks.find(
    (hunk) => oldLine >= hunk.deletionStart && oldLine < hunk.deletionStart + hunk.deletionCount,
  );
  if (!hunk) return null;
  const oldIndex = oldLine - hunk.deletionStart + hunk.deletionLineIndex;
  for (const block of hunk.hunkContent) {
    if (block.type !== 'context') continue;
    const offset = oldIndex - block.deletionLineIndex;
    if (offset >= 0 && offset < block.lines) {
      return hunk.additionStart + block.additionLineIndex - hunk.additionLineIndex + offset;
    }
  }
  return null;
}

export function withInlineThreads(
  item: CodeViewItem<Annot> | null,
  threads: InlineThread[],
  expanded: ReadonlyMap<string, boolean>,
  markers: Map<string, LineThreadMarker[]>,
  deleted: boolean,
  diffStyle: 'split' | 'unified',
): CodeViewItem<Annot> | null {
  if (!item || !threads.length) return item;
  const gutter: LineThreadMarker[] = [];
  const contents = item.type === 'file' ? item.file.contents : '';
  const fileLines = contents ? contents.split('\n').length - Number(contents.endsWith('\n')) : 0;
  const annotations: DiffLineAnnotation<Annot>[] = [];
  for (const thread of threads) {
    const { key, resolved, origin, line, side } = position(thread);
    const lineNumber = renderableLine(item, line, side, fileLines);
    const annotationSide = (lineNumber ? side === 'old' : deleted) ? 'deletions' : 'additions';
    const defaultOpen = !resolved;
    const open = expanded.get(key) ?? defaultOpen;
    if (resolved || !open) {
      const label = `${open ? 'Collapse' : 'Open'} ${resolved ? 'resolved ' : ''}${origin} thread`;
      const marker = { key, label, open, defaultOpen };
      if (lineNumber) {
        const unified = diffStyle === 'unified' && side === 'old' ? unifiedContextLine(item, lineNumber) : null;
        gutter.push({ ...marker, line: unified ?? lineNumber, side: unified == null ? side : 'new' });
      } else annotations.push({ lineNumber, side: annotationSide, metadata: { kind: 'threadMarker', marker } });
    }
    if (open) annotations.push({ lineNumber, side: annotationSide, metadata: thread } as DiffLineAnnotation<Annot>);
  }
  if (gutter.length) markers.set(item.id, gutter);
  if (item.type === 'diff') return { ...item, annotations: [...(item.annotations ?? []), ...annotations] };
  const fileAnnotations = annotations.map(
    ({ lineNumber, metadata }) => ({ lineNumber, metadata }) as LineAnnotation<Annot>,
  );
  return { ...item, annotations: [...(item.annotations ?? []), ...fileAnnotations] };
}
