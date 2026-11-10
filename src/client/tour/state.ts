import { create } from 'zustand';
import { api, isNotFound } from '@/client/api.js';
import { useStore, type ViewPlace } from '@/client/store.js';
import { showView, useViews } from '@/client/views/state.js';
import type { Side, Snapshot, Tour } from '@/shared/protocol.js';
import { readTour, type LineRange, type TourDocument } from './document.js';
import { excerpt } from './excerpt.js';

export type TourLoad =
  | { state: 'none' }
  | { state: 'ready'; tour: Tour; doc: TourDocument }
  | { state: 'error'; message: string };

interface TourState {
  load: TourLoad;
  /** The step shown, an index into `doc.steps`; -1 before the first. */
  step: number;
  /** A card to glide to, and a count that repeats the glide for the same card. */
  focus: { id: string; seq: number } | null;
  /** Cards whose lines left the review, in the current snapshot. */
  stale: ReadonlySet<string>;
  /** Shows step `index` and glides to its card. */
  goTo(index: number): void;
  move(by: 1 | -1): void;
}

export const useTour = create<TourState>((set, get) => ({
  load: { state: 'none' },
  step: -1,
  focus: null,
  stale: new Set(),
  goTo(index) {
    const { load, focus } = get();
    const card = load.state === 'ready' ? load.doc.steps[index] : undefined;
    if (!card) return;
    set({ step: index, focus: { id: card.id, seq: (focus?.seq ?? 0) + 1 } });
  },
  move(by) {
    const { load, step } = get();
    if (load.state !== 'ready' || !load.doc.steps.length) return;
    get().goTo(Math.max(0, Math.min(load.doc.steps.length - 1, step + by)));
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

/** The patch showing `range`, or null when its lines left the review. */
export async function rangePatch(range: LineRange): Promise<string | null> {
  const { text, patch } = await source(range.path, range.side);
  return text == null ? null : excerpt(range, text, patch);
}

let generation = 0;
let following = false;

/**
 * Fetches the review's tour and which of its cards went stale. A shown step stays when the tour is
 * pushed again. The first call starts following the review: a new snapshot rechecks the cards,
 * and another comment key, another review's tour.
 */
export async function refreshTour(): Promise<void> {
  follow();
  const g = ++generation;
  try {
    const { tour } = await api.tour();
    if (g !== generation) return;
    if (!tour) return set({ state: 'none' });
    const doc = readTour(tour.html);
    set({ state: 'ready', tour, doc });
    const stale = await staleCards(doc);
    if (g === generation) useTour.setState({ stale });
  } catch (e) {
    if (g === generation) set({ state: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

function set(load: TourLoad): void {
  const { step } = useTour.getState();
  const steps = load.state === 'ready' ? load.doc.steps.length : 0;
  useTour.setState({ load, step: Math.min(step, steps - 1) });
  // A tour cleared while shown leaves its view for the diff.
  if (load.state !== 'ready' && useViews.getState().active === 'tour') showView('diff');
}

async function staleCards(doc: TourDocument): Promise<Set<string>> {
  const stale = new Set<string>();
  await Promise.all(
    doc.cards.flatMap((card) =>
      card.ranges.map(async (range) => {
        if ((await rangePatch(range)) == null) stale.add(card.id);
      }),
    ),
  );
  return stale;
}

function follow(): void {
  if (following) return;
  following = true;
  useStore.subscribe((s, prev) => {
    if (s.snapshot === prev.snapshot || !s.snapshot) return;
    if (s.snapshot.commentKey !== prev.snapshot?.commentKey) void refreshTour();
    else {
      const load = useTour.getState().load;
      const g = generation;
      if (load.state === 'ready')
        void staleCards(load.doc).then((stale) => g === generation && useTour.setState({ stale }));
    }
  });
}

/** The step shown, for the jump list: Ctrl+o after a jump into the diff comes back to it. */
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
