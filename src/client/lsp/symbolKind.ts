import {
  Box,
  Braces,
  Component,
  FileCode2,
  Hammer,
  ListOrdered,
  type LucideIcon,
  type LucideProps,
  Parentheses,
  Shapes,
  SquareFunction,
  Type,
} from 'lucide-react';
import { createElement } from 'react';

/** LSP SymbolKind → short label. */
export const KIND_LABEL: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'ctor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'member',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'type param',
};

/** Semantic color group per SymbolKind: types, callables, values, containers; else neutral. */
export function kindGroup(kind: number): string {
  if ([5, 10, 11, 23, 26].includes(kind)) return 'type';
  if ([6, 9, 12].includes(kind)) return 'callable';
  if ([7, 8, 13, 14, 20, 22, 24].includes(kind)) return 'value';
  return kind <= 4 ? 'scope' : 'other';
}

const KIND_ICON: Record<number, LucideIcon> = {
  1: FileCode2,
  5: Box,
  6: Parentheses,
  9: Hammer,
  10: ListOrdered,
  11: Component,
  12: SquareFunction,
  23: Braces,
  26: Type,
};

const KIND_COLOR: Record<string, string> = {
  type: 'var(--kind-type)',
  callable: 'var(--kind-callable)',
  value: 'var(--kind-value)',
};

/** The color of a symbol's name and icon: the code theme's for its `kindGroup`, none for the rest. */
export const kindColor = (kind: number): string | undefined => KIND_COLOR[kindGroup(kind)];

/** An icon per SymbolKind, so a list or graph of symbols reads by shape before text, in its `kindColor`. */
export function KindIcon({ kind, ...props }: LucideProps & { kind: number }) {
  return createElement(KIND_ICON[kind] ?? Shapes, { color: kindColor(kind) ?? 'var(--fg-2)', ...props });
}
