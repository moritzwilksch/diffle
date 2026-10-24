import {
  Ban,
  Binary,
  Box,
  Boxes,
  Braces,
  Brackets,
  CircleDashed,
  Component,
  Cuboid,
  File,
  FileCode,
  FileMinus,
  FilePen,
  FilePlus,
  FileSymlink,
  Hammer,
  Hash,
  Key,
  Layers,
  List,
  Lock,
  Package,
  Parentheses,
  Percent,
  Puzzle,
  Quote,
  SquareFunction,
  ToggleLeft,
  Type,
  Variable,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { KIND_LABEL, kindGroup } from '@/client/lsp/symbolKind.js';
import type { NodeStatus } from './model.js';

export interface Glyph {
  label: string;
  Icon: LucideIcon;
  /** A theme-token text colour class. */
  text: string;
}

/** What a file's change looks like in the graph: an icon and a colour, never the colour alone. */
export const STATUS: Record<NodeStatus, Glyph> = {
  added: { label: 'Added', Icon: FilePlus, text: 'text-add' },
  modified: { label: 'Modified', Icon: FilePen, text: 'text-accent' },
  deleted: { label: 'Deleted', Icon: FileMinus, text: 'text-del' },
  renamed: { label: 'Renamed', Icon: FileSymlink, text: 'text-kind-type' },
  context: { label: 'Unchanged caller', Icon: FileCode, text: 'text-muted' },
};

/** LSP SymbolKind number to icon; the labels and colour groups come from `symbolKind.ts`. */
const KIND_ICON: Record<number, LucideIcon> = {
  1: File,
  2: Package,
  3: Boxes,
  4: Layers,
  5: Box,
  6: SquareFunction,
  7: Wrench,
  8: Hash,
  9: Hammer,
  10: List,
  11: Puzzle,
  12: Parentheses,
  13: Variable,
  14: Lock,
  15: Quote,
  16: Binary,
  17: ToggleLeft,
  18: Brackets,
  19: Braces,
  20: Key,
  21: Ban,
  22: Component,
  23: Cuboid,
  24: Zap,
  25: Percent,
  26: Type,
};

const FALLBACK_LABEL = 'Symbol';

const GROUP_TEXT: Record<string, string> = {
  type: 'text-kind-type',
  callable: 'text-kind-callable',
  value: 'text-kind-value',
};
const NEUTRAL_TEXT = 'text-muted';

/** The icon, label and colour of a symbol kind; an unknown number gets a generic "Symbol". */
export function kindGlyph(kind: number): Glyph {
  return {
    label: KIND_LABEL[kind] ?? FALLBACK_LABEL,
    Icon: KIND_ICON[kind] ?? CircleDashed,
    text: GROUP_TEXT[kindGroup(kind)] ?? NEUTRAL_TEXT,
  };
}
