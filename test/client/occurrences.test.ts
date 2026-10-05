// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspOccurrence } from '../../src/shared/protocol.js';

const store = {
  snapshot: { version: 1 } as { version: number } | null,
  occurrences: null as { target: unknown; items: LspOccurrence[] } | null,
  requestOccurrences: vi.fn(async (_target: unknown): Promise<LspOccurrence[] | null> => null),
  clearOccurrences: vi.fn(() => {
    store.occurrences = null;
  }),
};
vi.mock('../../src/client/store.js', () => ({
  useStore: {
    getState: () => store,
    setState: (patch: Partial<typeof store>) => Object.assign(store, patch),
  },
}));

const { KEY_MS, occurrenceControl, occurrenceRanges, POINTER_MS } = await import('../../src/client/lsp/occurrences.js');

const occ = (line: number, col: number, endCol: number, kind: LspOccurrence['kind'] = 'read'): LspOccurrence => ({
  line,
  col,
  endLine: line,
  endCol,
  kind,
});

/** A rendered row: tokens carry the column they start at; a word-diff emphasis can nest inside one. */
function row(html: string): HTMLElement {
  const el = document.createElement('div');
  el.dataset.line = '1';
  el.innerHTML = html;
  return el;
}

const painted = (r: HTMLElement, line: number, items: LspOccurrence[]) =>
  occurrenceRanges(r, line, items).map(({ range, kind }) => `${kind}:${range.toString()}`);

describe('occurrenceRanges', () => {
  it('maps columns onto token text nodes, one range per token an occurrence touches', () => {
    // `total = self.total + x`: columns 0-5 `total`, 6-7 ` = `, 8-12 `self`, 12 `.`, 13-18 `total`...
    const r = row(
      '<span data-char="0">total</span><span data-char="5"> = </span><span data-char="8">self</span>' +
        '<span data-char="12">.</span><span data-char="13">total</span><span data-char="18"> + </span>' +
        '<span data-char="21">x</span>',
    );
    expect(painted(r, 1, [occ(1, 0, 5, 'write'), occ(1, 13, 18), occ(1, 21, 22)])).toEqual([
      'write:total',
      'read:total',
      'read:x',
    ]);
    // An occurrence the highlighter split across tokens (`a.b` as one symbol) yields a piece per token.
    expect(painted(r, 1, [occ(1, 8, 18, 'text')])).toEqual(['text:self', 'text:.', 'text:total']);
  });

  it('walks nested text nodes inside a token and clips a multi-line occurrence to the row', () => {
    // `renamed_value` fills columns 4 to 17.
    const r = row('<span data-char="4"><span>ren</span><em>amed</em>_value</span>');
    expect(painted(r, 1, [occ(1, 4, 17)])).toEqual(['read:renamed_value']);
    expect(painted(r, 1, [occ(1, 7, 13)])).toEqual(['read:amed_v']);
    // Columns before the token, or past its end, are not on this row's text.
    expect(painted(r, 1, [occ(1, 0, 4), occ(1, 17, 20)])).toEqual([]);
    const tall: LspOccurrence = { line: 1, col: 10, endLine: 3, endCol: 6, kind: 'read' };
    expect(painted(r, 1, [tall])).toEqual(['read:d_value']);
    expect(painted(r, 2, [tall])).toEqual(['read:renamed_value']);
    expect(painted(r, 3, [tall])).toEqual(['read:re']);
    expect(painted(r, 4, [tall])).toEqual([]);
  });

  it('ignores occurrences on other lines and tokens without a column', () => {
    const r = row('<span>plain</span><span data-char="0">amount</span>');
    expect(painted(r, 1, [occ(2, 0, 6)])).toEqual([]);
    expect(painted(r, 1, [occ(1, 0, 6)])).toEqual(['read:amount']);
  });
});

describe('occurrenceControl', () => {
  const target = (text: string, line = 1, col = 0) => ({ path: 'a.py', side: 'new' as const, line, col, text });
  const a = target('a', 1, 0);
  const b = target('b', 2, 4);
  beforeEach(() => {
    vi.useFakeTimers();
    store.snapshot = { version: 1 };
    store.occurrences = null;
    store.requestOccurrences.mockReset();
    store.requestOccurrences.mockImplementation(async () => null);
    store.clearOccurrences.mockClear();
  });
  afterEach(() => {
    occurrenceControl.reset();
    vi.useRealTimers();
  });

  it('asks once after the keyboard pause, however often the focus moved meanwhile', () => {
    occurrenceControl.focus(a);
    occurrenceControl.focus(b);
    occurrenceControl.focus(a);
    vi.advanceTimersByTime(KEY_MS - 1);
    expect(store.requestOccurrences).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(store.requestOccurrences).toHaveBeenCalledTimes(1);
    expect(store.requestOccurrences).toHaveBeenLastCalledWith(a);
  });

  it('lets the pointer win while it rests on a symbol and hands back to the focus when it leaves', async () => {
    const items = [occ(1, 0, 1)];
    store.requestOccurrences.mockImplementation(async (t: unknown) => {
      store.occurrences = { target: t, items };
      return items;
    });

    occurrenceControl.focus(a);
    await vi.advanceTimersByTimeAsync(KEY_MS);
    expect(store.occurrences?.target).toBe(a);
    // A pointer rest clears the stale tint at once and asks after its own, longer pause.
    occurrenceControl.hover(b);
    expect(store.clearOccurrences).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KEY_MS);
    expect(store.requestOccurrences).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POINTER_MS - KEY_MS);
    expect(store.requestOccurrences).toHaveBeenLastCalledWith(b);
    expect(store.occurrences?.target).toBe(b);
    // The focus moving under a resting pointer changes nothing.
    occurrenceControl.focus(target('c', 3, 0));
    await vi.advanceTimersByTimeAsync(KEY_MS);
    expect(store.requestOccurrences).toHaveBeenCalledTimes(2);
    // Leaving paints the focused symbol's answer again from the cache, without asking.
    occurrenceControl.focus(a);
    occurrenceControl.hover(null);
    expect(store.occurrences?.target).toBe(a);
    expect(store.requestOccurrences).toHaveBeenCalledTimes(2);
    // A hover that comes back is answered from the cache too; a new snapshot forgets it.
    occurrenceControl.hover(b);
    expect(store.occurrences?.target).toBe(b);
    store.snapshot = { version: 2 };
    occurrenceControl.hover(null);
    occurrenceControl.hover(b);
    expect(store.occurrences).toBeNull();
    await vi.advanceTimersByTimeAsync(POINTER_MS);
    expect(store.requestOccurrences).toHaveBeenCalledTimes(3);
  });

  it('remembers only answers that named occurrences', async () => {
    store.requestOccurrences.mockImplementation(async () => []);
    occurrenceControl.focus(a);
    await vi.advanceTimersByTimeAsync(KEY_MS);
    occurrenceControl.focus(null);
    occurrenceControl.focus(a);
    await vi.advanceTimersByTimeAsync(KEY_MS);
    expect(store.requestOccurrences).toHaveBeenCalledTimes(2);
  });

  it('paints nothing with no symbol under either source', () => {
    occurrenceControl.focus(a);
    occurrenceControl.focus(null);
    vi.advanceTimersByTime(POINTER_MS);
    expect(store.requestOccurrences).not.toHaveBeenCalled();
    expect(store.clearOccurrences).toHaveBeenCalled();
  });
});
