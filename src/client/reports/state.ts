import { create } from 'zustand';
import { api } from '@/client/api.js';
import { useStore, type ViewPlace } from '@/client/store.js';
import { showView } from '@/client/views/state.js';
import type { Report, ReportAnchor, ReportTarget } from '@/shared/protocol.js';

export interface ReportsState {
  reports: Report[];
  /** The target a pushed report should name now; null before the first load. */
  current: ReportTarget | null;
  /** The first load answered, so an empty list means no reports rather than none yet. */
  loaded: boolean;
  error: string | null;
  /** The report shown, by id; null shows the first. */
  selected: string | null;
  /** The block the cursor is on in the shown report: `c` comments at its anchor. */
  cursor: number;
  /** The log open under the shown report's header, by id. */
  log: { id: string; lines: string[] } | null;
  refresh(): Promise<void>;
  select(id: string | null): void;
  moveCursor(by: 1 | -1): void;
  setCursor(index: number): void;
  /** Shows the next (or previous) report in the list. */
  step(by: 1 | -1): void;
  /** Leaves for the diff at `anchor`, and opens a comment there on the new side. */
  comment(anchor: ReportAnchor): Promise<void>;
  /** Leaves for the diff at `anchor`. */
  jump(anchor: ReportAnchor): Promise<void>;
  /** Opens the log of report `id`, or closes it when it is the one open. */
  toggleLog(id: string): Promise<void>;
}

let loads = 0;

/** The reports view. It reads the review store and never the other way round. */
export const useReports = create<ReportsState>((set, get) => ({
  reports: [],
  current: null,
  loaded: false,
  error: null,
  selected: null,
  cursor: 0,
  log: null,

  async refresh() {
    const generation = ++loads;
    try {
      const res = await api.reports();
      if (generation !== loads) return;
      const shown = shownReport({ ...get(), reports: res.reports });
      set({
        reports: res.reports,
        current: res.current,
        loaded: true,
        error: null,
        cursor: Math.min(get().cursor, Math.max(0, (shown?.blocks.length ?? 1) - 1)),
      });
      const log = get().log;
      if (log && !res.reports.some((r) => r.id === log.id)) set({ log: null });
    } catch (e) {
      if (generation === loads) set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  select(id) {
    if (id === get().selected) return;
    set({ selected: id, cursor: 0, log: null });
  },

  moveCursor(by) {
    const shown = shownReport(get());
    if (!shown || shown.blocks.length === 0) return;
    const cursor = Math.max(0, Math.min(shown.blocks.length - 1, get().cursor + by));
    set({ cursor });
    document.querySelector(`[data-report-block="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  },

  setCursor(index) {
    set({ cursor: index });
  },

  step(by) {
    const { reports } = get();
    if (reports.length === 0) return;
    const shown = shownReport(get());
    const at = reports.findIndex((r) => r.id === shown?.id);
    const next = reports[(at + by + reports.length) % reports.length]!;
    get().select(next.id);
  },

  async comment(anchor) {
    await get().jump(anchor);
    const review = useStore.getState();
    // The cursor sits on the line once the jump landed on the new side; the old side takes no draft.
    if (anchor.side === 'old') return review.flash('Press c on the removed line to comment there');
    if (review.selection) void review.openDraft(review.selection);
  },

  async jump(anchor) {
    const review = useStore.getState();
    // Closed only once the jump is made: the jump list records the reports as the place left.
    if (anchor.side === 'old') await review.openFile(anchor.path, anchor.endLine ?? anchor.line, 'old');
    else await review.goToLink(anchor.path, anchor.line);
    showView('diff');
  },

  async toggleLog(id) {
    if (get().log?.id === id) return set({ log: null });
    try {
      const { lines } = await api.reportLog(id);
      set({ log: { id, lines } });
    } catch (e) {
      useStore.getState().flash(`Loading the log failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
}));

/** The report the view shows: the selected one, else the first. */
export function shownReport(s: Pick<ReportsState, 'reports' | 'selected'>): Report | null {
  return s.reports.find((r) => r.id === s.selected) ?? s.reports[0] ?? null;
}

/** The anchor the cursor's block points at, or null. A pages block anchors through its first page. */
export function cursorAnchor(s: Pick<ReportsState, 'reports' | 'selected' | 'cursor'>): ReportAnchor | null {
  const block = shownReport(s)?.blocks[s.cursor];
  if (!block) return null;
  if (block.kind === 'markdown') return block.anchor ?? null;
  return block.pages.find((p) => p.anchor)?.anchor ?? null;
}

export function enterReports(): void {
  const s = useReports.getState();
  if (!s.loaded) void s.refresh();
}

/** The reports as they stand, for the jump list: Ctrl+o after a jump into the diff restores them. */
export function reportsPlace(): ViewPlace {
  const { selected, cursor } = useReports.getState();
  return {
    view: `reports:${selected ?? ''}:${cursor}`,
    restore() {
      useReports.setState({ selected, cursor });
      showView('reports');
    },
  };
}
