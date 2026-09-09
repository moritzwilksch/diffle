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

/** Color group per SymbolKind (a CSS class on the label): types, callables, values, containers; else neutral. */
export function kindGroup(kind: number): string {
  if ([5, 10, 11, 23, 26].includes(kind)) return 'type';
  if ([6, 9, 12].includes(kind)) return 'callable';
  if ([7, 8, 13, 14, 20, 22, 24].includes(kind)) return 'value';
  return kind <= 4 ? 'scope' : 'other';
}
