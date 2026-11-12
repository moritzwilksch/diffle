import type { DiffLineAnnotation } from '@pierre/diffs';
import type { IconNode } from 'lucide-react';
import { type ComponentType, createContext, type ReactNode, useContext } from 'react';
import type { Place } from '@/client/tour/anchor.js';
import type { LineRange } from '@/client/tour/document.js';
import type { ChangedFile } from '@/shared/protocol.js';
import type { Side } from '@/shared/side.js';

/**
 * What a tour's blocks take from outside the document: the review's lines and how they are drawn,
 * the language servers, the reviewer's ticks, and the diff to open. The review in diffle is one
 * host; a tour exported as a file is another, holding what it showed when it was exported.
 */
export interface TourHost {
  /** The patch showing `range` and `context` lines around it, cut again whenever the review moves. */
  useExcerpt(range: LineRange, context: number): Shown;
  /** A patch's rows, unified, numbered and highlighted like the diff; `lang` overrides its file's. */
  Rows: <A>(props: RowsProps<A>) => ReactNode;
  /** Opens a place of the review in the diff; null where no diff stands behind the tour. */
  open: ((path: string, line?: number, side?: Side) => void) | null;
  /** A `diffle-symbol`. */
  Symbol: ComponentType<SymbolProps>;
  /** A `diffle-check`. */
  Check: ComponentType<CheckProps>;
  /** The review's changed files, by path. */
  useChanged(): ReadonlyMap<string, ChangedFile>;
  /** `lines` of `lang`, coloured token by token as the diff colours them; null until known. */
  useTokens(lines: readonly string[], lang: string): Token[][] | null;
  /** The Lucide icon `name`: undefined while it loads, null when no icon has the name. */
  useIcon(name: string): IconNode | null | undefined;
  /**
   * Calls `onFocus` with the index, among the child elements of the block at `place`, of the one
   * the focused thread is on, so the block shows it.
   */
  useFocusedChild(place: Place, onFocus: (child: number) => void): void;
}

/** What an excerpt shows: its patch once cut, or why it shows none. */
export type Shown =
  | { state: 'loading' }
  | { state: 'gone' }
  | { state: 'error'; message: string }
  | { state: 'ready'; patch: string };

export interface RowsProps<A> {
  patch: string;
  lang?: string;
  /** Styles for the rows, beside the diff's own. */
  css?: string;
  annotations?: DiffLineAnnotation<A>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode;
}

export interface SymbolProps {
  path: string;
  line: number;
  name: string;
  side: Side;
}

export interface CheckProps {
  source: Element;
  /** An item's question as the article renders inline prose. */
  renderItem: (item: Element) => ReactNode;
}

/** A run of code in one colour: a CSS colour, which may name both themes' with `light-dark()`. */
export interface Token {
  text: string;
  color?: string;
}

export const TourHostContext = createContext<TourHost | null>(null);

export function useHost(): TourHost {
  const host = useContext(TourHostContext);
  if (!host) throw new Error('a tour renders inside a TourHostContext');
  return host;
}

/** A short key naming `patch`'s rows in `lang`: what a highlight is cached and an export keeps them under. */
export function rowsKey(patch: string, lang = ''): string {
  const text = `${lang}\n${patch}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}
