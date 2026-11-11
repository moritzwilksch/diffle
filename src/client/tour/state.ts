import { create } from 'zustand';
import { api, isNotFound } from '@/client/api.js';
import { useStore, type ViewPlace } from '@/client/store.js';
import { showView, useViews } from '@/client/views/state.js';
import type { Side, Snapshot, Tour, TourCheckItem } from '@/shared/protocol.js';
import { readTour, type LineRange, type TourDocument } from './document.js';
import { excerpt } from './excerpt.js';

export type TourLoad =
  | { state: 'none' }
  | { state: 'ready'; tour: Tour; doc: TourDocument; checks: TourCheckItem[] }
  | { state: 'error'; message: string };

interface TourState {
  load: TourLoad;
  /** The section read, an index into `doc.sections`; -1 before the first. */
  step: number;
  /** A heading to scroll to (an `h3` by its index when `sub` is set), and a count that repeats the scroll. */
  focus: { section: number; sub: number | null; seq: number } | null;
  /** A thread to scroll to, and a count that repeats the scroll. */
  reveal: { id: string; seq: number } | null;
  /** Sections holding a `diffle-diff` whose lines left the review, in the current snapshot. */
  stale: ReadonlySet<number>;
  /** How many `diffle-diff`s went stale. */
  staleDiffs: number;
  /** Shows section `index`, or its subsection `sub`, and scrolls its heading near the page's top. */
  goTo(index: number, sub?: number): void;
  move(by: 1 | -1): void;
  /** Shows the tour with thread `id` focused, scrolled to what it is on. */
  revealThread(id: string): void;
}

export const useTour = create<TourState>((set, get) => ({
  load: { state: 'none' },
  step: -1,
  focus: null,
  reveal: null,
  stale: new Set(),
  staleDiffs: 0,
  goTo(index, sub) {
    const { load, focus } = get();
    if (load.state !== 'ready' || !load.doc.sections[index]) return;
    set({ step: index, focus: { section: index, sub: sub ?? null, seq: (focus?.seq ?? 0) + 1 } });
  },
  revealThread(id) {
    showView('tour');
    useStore.getState().focusThread(id);
    set({ reveal: { id, seq: (get().reveal?.seq ?? 0) + 1 } });
  },
  move(by) {
    const { load, step } = get();
    if (load.state !== 'ready' || !load.doc.sections.length) return;
    get().goTo(Math.max(0, Math.min(load.doc.sections.length - 1, step + by)));
  },
}));

/** One side of a file as the shown snapshot has it, and its patch in the review. */
export interface Source {
  /** Null when the file is absent on that side. */
  text: string | null;
  patch: string;
}

let sources = new Map<string, Promise<Source>>();
let sourcesOf: Snapshot | null = null;

/** `path` on `side` in the shown snapshot, fetched once per snapshot. */
export function source(path: string, side: Side): Promise<Source> {
  const snap = useStore.getState().snapshot;
  if (snap !== sourcesOf) [sources, sourcesOf] = [new Map(), snap];
  const key = `${side}:${path}`;
  let found = sources.get(key);
  if (!found) {
    const changed = snap?.changed.some((f) => f.path === path) ?? false;
    found = Promise.all([
      api.file(path, side).then(
        (f) => (f.binary ? null : f.contents),
        (e: unknown) => (isNotFound(e) ? null : Promise.reject(e)),
      ),
      changed ? api.patch(path) : '',
    ]).then(([text, patch]) => ({ text, patch }));
    sources.set(key, found);
  }
  return found;
}

/**
 * The patch showing `range` and `context` lines on each side of it as far as the file goes, or
 * null when its lines left the review.
 */
export async function rangePatch(range: LineRange, context = 0): Promise<string | null> {
  const { text, patch } = await source(range.path, range.side);
  if (text == null) return null;
  const count = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  if (range.end > count) return null;
  return excerpt(
    { ...range, start: Math.max(1, range.start - context), end: Math.min(count, range.end + context) },
    text,
    patch,
  );
}

let generation = 0;
/** Counts stale checks apart from loads: a newer snapshot's check supersedes an older one without cancelling a load. */
let checks = 0;
let following = false;

/**
 * Fetches the review's tour and which of its diffs went stale. A shown section stays when the tour
 * is pushed again. The first call starts following the review: a new snapshot rechecks the diffs,
 * and another comment key, another review's tour.
 */
export async function refreshTour(): Promise<void> {
  follow();
  const g = ++generation;
  try {
    const { tour, checks: items } = await api.tour();
    if (g !== generation) return;
    if (!tour) return set({ state: 'none' });
    const doc = readTour(tour.html);
    set({ state: 'ready', tour, doc, checks: items });
    const c = ++checks;
    const stale = await staleSections(doc);
    if (g === generation && c === checks) useTour.setState(stale);
  } catch (e) {
    if (g === generation) set({ state: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

function set(load: TourLoad): void {
  const { step } = useTour.getState();
  const steps = load.state === 'ready' ? load.doc.sections.length : 0;
  useTour.setState({ load, step: Math.min(step, steps - 1) });
  // A tour cleared while shown leaves its view for the diff.
  if (load.state !== 'ready' && useViews.getState().active === 'tour') showView('diff');
}

async function staleSections(doc: TourDocument): Promise<{ stale: Set<number>; staleDiffs: number }> {
  const stale = new Set<number>();
  let staleDiffs = 0;
  await Promise.all(
    doc.sections.flatMap((section) =>
      section.ranges.map(async (range) => {
        if ((await rangePatch(range)) != null) return;
        stale.add(section.index);
        staleDiffs++;
      }),
    ),
  );
  return { stale, staleDiffs };
}

function follow(): void {
  if (following) return;
  following = true;
  useStore.subscribe((s, prev) => {
    if (s.snapshot === prev.snapshot || !s.snapshot) return;
    if (s.snapshot.commentKey !== prev.snapshot?.commentKey) void refreshTour();
    else {
      const load = useTour.getState().load;
      if (load.state !== 'ready') return;
      const c = ++checks;
      void staleSections(load.doc).then((stale) => c === checks && useTour.setState(stale));
    }
  });
}

/** The section read, for the jump list: Ctrl+o after a jump into the diff comes back to it. */
export function tourPlace(): ViewPlace {
  const { step } = useTour.getState();
  return {
    view: `tour:${step}`,
    restore() {
      showView('tour');
      if (step >= 0) useTour.getState().goTo(step);
    },
  };
}

/** Opens the diff at `path`, on `line` of `side` when given. */
export async function jump(path: string, line?: number, side: Side = 'new'): Promise<void> {
  const review = useStore.getState();
  if (line != null && side === 'old') review.jumpTo(path, line, 'old');
  else await review.goToLink(path, line);
  showView('diff');
}
