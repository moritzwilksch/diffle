// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Report, ReportAnchor } from '@/shared/protocol.js';

const review = vi.hoisted(() => ({
  flash: vi.fn(),
  goToLink: vi.fn(async () => {}),
  openFile: vi.fn(async () => {}),
  openDraft: vi.fn(async () => {}),
  selection: null as { id: string } | null,
}));
vi.mock('@/client/store.js', () => ({ useStore: { getState: () => review } }));
const shown = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@/client/views/state.js', () => ({ showView: (id: string) => shown.ids.push(id) }));
const api = vi.hoisted(() => ({ reports: vi.fn(), reportLog: vi.fn() }));
vi.mock('@/client/api.js', () => ({ api }));

const { cursorAnchor, shownReport, useReports } = await import('@/client/reports/state.js');
const { reportsKeys } = await import('@/client/reports/keys.js');

const target = { oldSha: 'a', newSha: 'b', digest: 'c' };
const anchor: ReportAnchor = { path: 'src/app.py', line: 3 };
function report(id: string, blocks: Report['blocks']): Report {
  return {
    id,
    source: 'pushed',
    title: id,
    summary: '',
    target,
    status: 'ready',
    error: null,
    stale: false,
    updatedAt: 0,
    blocks,
  };
}
const notes = report('notes', [
  { kind: 'markdown', text: 'plain' },
  { kind: 'markdown', text: 'placed', anchor },
  {
    kind: 'pages',
    pages: [{ label: 'p. 1', old: null, new: { key: 'k', type: 'image/png' }, anchor: { ...anchor, line: 9 } }],
  },
]);
const other = report('other', []);

const key = (k: string) => new KeyboardEvent('keydown', { key: k });

describe('the reports view state', () => {
  it('shows the selected report, else the first, and reads the cursor block’s anchor', () => {
    expect(shownReport({ reports: [notes, other], selected: null })?.id).toBe('notes');
    expect(shownReport({ reports: [notes, other], selected: 'other' })?.id).toBe('other');
    expect(shownReport({ reports: [notes], selected: 'gone' })?.id).toBe('notes');
    expect(cursorAnchor({ reports: [notes], selected: null, cursor: 0 })).toBeNull();
    expect(cursorAnchor({ reports: [notes], selected: null, cursor: 1 })).toEqual(anchor);
    expect(cursorAnchor({ reports: [notes], selected: null, cursor: 2 })?.line).toBe(9);
    expect(cursorAnchor({ reports: [], selected: null, cursor: 0 })).toBeNull();
  });

  it('refreshes from the API, keeping the cursor inside the shown report', async () => {
    api.reports.mockResolvedValueOnce({ current: target, reports: [notes, other] });
    useReports.setState({ cursor: 7 });
    await useReports.getState().refresh();
    expect(useReports.getState().reports.map((r) => r.id)).toEqual(['notes', 'other']);
    expect(useReports.getState().cursor).toBe(2);
    expect(useReports.getState().loaded).toBe(true);
  });

  it('walks blocks and reports with the keys, and leaves for the diff at an anchor', async () => {
    useReports.setState({ reports: [notes, other], selected: null, cursor: 0 });
    expect(reportsKeys(key('j'))).toBe(true);
    expect(reportsKeys(key('j'))).toBe(true);
    expect(reportsKeys(key('j'))).toBe(true);
    expect(useReports.getState().cursor).toBe(2);
    expect(reportsKeys(key('k'))).toBe(true);
    expect(useReports.getState().cursor).toBe(1);
    expect(reportsKeys(key('J'))).toBe(true);
    expect(useReports.getState().selected).toBe('other');
    expect(useReports.getState().cursor).toBe(0);
    expect(reportsKeys(key('['))).toBe(true);
    expect(useReports.getState().selected).toBe('notes');
    expect(reportsKeys(key('x'))).toBe(false);

    // A block without an anchor says so; one with it opens the diff there, `c` with a comment.
    useReports.setState({ cursor: 0 });
    expect(reportsKeys(key('Enter'))).toBe(true);
    expect(review.flash).toHaveBeenCalledWith('This block points at no line of the diff');
    useReports.setState({ cursor: 1 });
    review.selection = { id: 'src/app.py' };
    expect(reportsKeys(key('c'))).toBe(true);
    await vi.waitFor(() => expect(review.openDraft).toHaveBeenCalledWith({ id: 'src/app.py' }));
    expect(review.goToLink).toHaveBeenCalledWith('src/app.py', 3);
    expect(shown.ids).toEqual(['diff']);
  });

  it('jumps to a removed line without a draft', async () => {
    review.openDraft.mockClear();
    await useReports.getState().comment({ path: 'src/app.py', side: 'old', line: 4, endLine: 5 });
    expect(review.openFile).toHaveBeenCalledWith('src/app.py', 5, 'old');
    expect(review.openDraft).not.toHaveBeenCalled();
    expect(review.flash).toHaveBeenCalledWith('Press c on the removed line to comment there');
  });
});
