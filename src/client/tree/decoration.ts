import type { ChangedFile, ViewedState } from '@/shared/protocol.js';

// The decoration lane holds one span of colored text parts: the viewed mark as a glyph, then the
// file's +/− counts (the lane takes either text or one icon, not both). The mark leads so it can
// float right of the counts (`treeCss.ts`).
const MARK: Record<ViewedState, { glyph: string; color: string; title: string }> = {
  viewed: {
    glyph: '✓',
    color: 'var(--add)',
    title: 'Viewed · click or v to toggle',
  },
  unviewed: {
    glyph: '○',
    color: 'var(--fg-2)',
    title: 'Not viewed · click or v to toggle',
  },
  restale: {
    glyph: '◐',
    color: 'var(--warn)',
    title: 'Changed since you viewed it · click or v to mark viewed again',
  },
};

export function rowDecoration(f: ChangedFile, state: ViewedState) {
  const mark = MARK[state];
  const parts: { text: string; color?: string }[] = [{ text: mark.glyph, color: mark.color }];
  if (f.additions > 0) parts.push({ text: `+${f.additions}`, color: 'var(--add)' });
  if (f.deletions > 0) parts.push({ text: `−${f.deletions}`, color: 'var(--del)' });
  const counts = f.binary ? 'binary' : `+${f.additions} −${f.deletions}`;
  return {
    text: parts.map((p) => p.text).join(' '),
    parts,
    title: `${counts} · ${mark.title}`,
  };
}

// A directory's mark sums its changed files: a check once all are viewed, else the progress so far.
export function directoryDecoration(viewedCount: number, total: number) {
  if (viewedCount === total) {
    const title = `All ${total} changed file(s) viewed · click to mark them not viewed`;
    return {
      text: MARK.viewed.glyph,
      parts: [{ text: MARK.viewed.glyph, color: MARK.viewed.color }],
      title,
    };
  }
  const parts: { text: string; color?: string }[] = [{ text: MARK.unviewed.glyph, color: MARK.unviewed.color }];
  if (viewedCount > 0) parts.push({ text: `${viewedCount}/${total}`, color: 'var(--fg-2)' });
  const title = `${viewedCount} of ${total} changed file(s) viewed · click to mark all viewed`;
  return { text: parts.map((p) => p.text).join(' '), parts, title };
}
