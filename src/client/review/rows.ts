/**
 * Rendered-row queries against a diff item's shadow root. Both columns of a
 * split diff, and both kinds of row in a unified one, carry `data-line`; a
 * deleted row is numbered on the old side and lives either under the
 * `[data-deletions]` column or as a `change-deletion` row inline.
 */
export function isDeletionRow(row: HTMLElement): boolean {
  return row.dataset.lineType === 'change-deletion' || (row.closest('code')?.hasAttribute('data-deletions') ?? false);
}

/** The rendered row for `line` on one side, or null when it is not on screen. */
export function rowOf(root: ParentNode, line: number, side: 'old' | 'new'): HTMLElement | null {
  const wantDeletion = side === 'old';
  return (
    [...root.querySelectorAll<HTMLElement>(`[data-line="${line}"]`)].find((r) => isDeletionRow(r) === wantDeletion) ??
    null
  );
}
