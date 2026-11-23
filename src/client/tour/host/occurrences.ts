import type { PostRenderPhase } from '@pierre/diffs';
import {
  clearOccurrences,
  occurrenceControl,
  occurrenceCss,
  paintOccurrences,
  sameToken,
  supported,
} from '@/client/lsp/occurrences.js';
import { useStore } from '@/client/store.js';

/**
 * The tour's tint of where the symbol under the pointer recurs, as the diff tints it. Its own
 * highlight names: highlights are global by name, and the review paints its own rows under its own.
 */
const NAMES = {
  text: 'diffle-tour-occurrence',
  read: 'diffle-tour-occurrence-read',
  write: 'diffle-tour-occurrence-write',
} as const;

/** The tint's styles, for the shadow root an excerpt's rows render in. */
export const TOUR_OCCURRENCE_CSS = occurrenceCss(NAMES);

/** Each rendered excerpt, by the element its rows render under, and the file its rows are. */
const excerpts = new Map<HTMLElement, string>();
let unsubscribe: (() => void) | null = null;
let frame = 0;

/**
 * The viewer's `onPostRender` for the rows of `path`: keeps them among the excerpts the tint
 * paints, repainted as they render.
 */
export function trackExcerpt(path: string, node: HTMLElement, phase: PostRenderPhase): void {
  if (!supported()) return;
  if (phase === 'unmount') excerpts.delete(node);
  else excerpts.set(node, path);
  unsubscribe ??= useStore.subscribe((s, prev) => {
    if (s.occurrences !== prev.occurrences) schedule();
  });
  schedule();
}

function schedule(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    paint();
  });
}

/**
 * Tints only while the pointer rests on the symbol asked about: the keyboard's word focus, which the
 * diff falls back to, sits in the diff and is not shown here.
 */
function paint(): void {
  const occurrences = useStore.getState().occurrences;
  const pointed = occurrenceControl.pointed();
  if (!excerpts.size) {
    unsubscribe?.();
    unsubscribe = null;
    return clearOccurrences(NAMES);
  }
  const shown = occurrences && pointed && sameToken(occurrences.target, pointed) ? occurrences : null;
  const roots = [...excerpts].map(([node, path]) => ({ path, root: node.shadowRoot ?? node }));
  paintOccurrences(NAMES, roots, shown);
}
