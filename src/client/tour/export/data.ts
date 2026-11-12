import type { IconNode } from 'lucide-react';
import type { LineRange } from '@/client/tour/document.js';
import { rowsKey, type SymbolProps, type Token } from '@/client/tour/host/host.js';
import type { ChangedFile, TourCheckItem } from '@/shared/protocol.js';

/**
 * A tour exported as one file: its document, and everything its blocks showed when it was
 * exported, as they showed it. The file carries no highlighter and asks nothing of a server.
 */
export interface BakedTour {
  /** The tour's document, as the agent pushed it. */
  html: string;
  /** Each excerpt's patch by `excerptKey`; null when its lines had left the review. */
  excerpts: Record<string, string | null>;
  /** Each patch's rows by `rowsKey`, highlighted, as markup for the diff's shadow root. */
  rows: Record<string, string>;
  /** The stylesheet every shadow root of rows shares. */
  rowsCss: string;
  /** Each symbol chip by `symbolKey`: its colour, and its hover's Markdown when it had one. */
  symbols: Record<string, { color?: string; hover?: string }>;
  /** Each diagram's code by `tokensKey`, coloured token by token. */
  tokens: Record<string, Token[][]>;
  icons: Record<string, IconNode>;
  /** The changed files the tour's trees list. */
  changed: ChangedFile[];
  /** The checklists' items as the server named them, each with its tick. */
  checks: TourCheckItem[];
}

/** The id of the `<script type="application/json">` the file keeps a `BakedTour` in. */
export const DATA_ID = 'diffle-tour';

export function excerptKey({ path, side, start, end }: LineRange, context: number): string {
  return `${side}:${path}:${start}-${end}+${context}`;
}

export function symbolKey({ path, line, name, side }: SymbolProps): string {
  return `${side}:${path}:${line}:${name}`;
}

export function tokensKey(lines: readonly string[], lang: string): string {
  return rowsKey(lines.join('\n'), lang);
}
