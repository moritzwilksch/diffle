import { api } from '@/client/api.js';
import { pathFromItemId } from '@/client/model.js';
import type { ReviewState } from '@/client/store.js';
import type { ReviewLocation } from '@/shared/protocol.js';
import type { RowAnchor } from './rows.js';

type Position = Omit<ReviewLocation, 'updatedAt'>;
let restored = false;
let last: Position | undefined;
let pending: ReviewLocation | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let stamp = 0;

export async function restoreReviewLocation(get: () => ReviewState, current: () => boolean): Promise<void> {
  if (restored) return;
  try {
    const position = await api.reviewLocation();
    if (!current()) return;
    const snapshot = get().snapshot;
    if (!snapshot || !position || position.commentKey !== snapshot.commentKey) return;
    const full = position.full && snapshot.tree.includes(position.path);
    if (!full && !snapshot.changed.some((file) => file.path === position.path)) return;
    if (position.line != null)
      await get().restorePosition({ path: position.path, line: position.line, side: position.side, full });
    else if (full) await get().openFullFile(position.path);
    else await get().openFile(position.path);
    if (current()) {
      stamp = position.updatedAt;
      last = position;
    }
  } catch {
    // Failure to restore a location must not prevent opening the review.
  } finally {
    if (current()) restored = true;
  }
}

function remember(position: Position): void {
  if (!restored) return;
  if (
    last?.commentKey === position.commentKey &&
    last.path === position.path &&
    last.line === position.line &&
    last.side === position.side &&
    last.full === position.full
  )
    return;
  last = position;
  stamp = Math.max(stamp + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  pending = { ...position, updatedAt: stamp };
  timer ??= setTimeout(flushReviewLocation, 75);
}

export function flushReviewLocation(): void {
  clearTimeout(timer);
  timer = undefined;
  if (!pending) return;
  const position = pending;
  pending = undefined;
  void api.saveReviewLocation(position).catch(() => {});
}

export function rememberViewport(state: ReviewState, anchor: RowAnchor): void {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const path = pathFromItemId(anchor.id);
  remember({
    commentKey: snapshot.commentKey,
    path,
    line: anchor.line,
    side: anchor.side,
    full: state.fileView?.path === path,
  });
}

export function rememberReviewLocation(state: ReviewState, previous: ReviewState): void {
  if (!state.snapshot || !state.activePath) return;
  if (
    state.activePath === previous.activePath &&
    state.selection === previous.selection &&
    state.scrollTarget === previous.scrollTarget
  )
    return;
  const path = state.activePath;
  const selection = state.selection;
  const scroll = state.scrollTarget;
  const selected = selection && pathFromItemId(selection.id) === path ? selection.range : null;
  const target = scroll && pathFromItemId(scroll.id) === path ? scroll : null;
  remember({
    commentKey: state.snapshot.commentKey,
    path,
    line: selected?.end ?? target?.line ?? null,
    side: selected ? ((selected.endSide ?? selected.side) === 'deletions' ? 'old' : 'new') : (target?.side ?? 'new'),
    full: state.fileView?.path === path,
  });
}
