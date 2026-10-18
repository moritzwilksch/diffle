import type { LspPosition, LspSymbol, LspSymbolsResponse } from '../../shared/protocol.js';
import type { Range } from './Locator.js';

// LSP wire shapes, only the fields read here, and how they become diffle's answers.
export interface Location {
  uri: string;
  range: Range;
}
export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}
export interface DocumentHighlight {
  range: Range;
  /** 1 Text, 2 Read, 3 Write; absent means Text. */
  kind?: number;
}
export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}
export interface SymbolInformation {
  name: string;
  kind: number;
  containerName?: string;
  location: Location | { uri: string };
}

export function symbolsResponse(symbols: LspSymbol[], busy: string | null): LspSymbolsResponse {
  return busy && !symbols.length ? { symbols, inconclusive: busy } : { symbols };
}

export function toLsp(pos: LspPosition): { line: number; character: number } {
  return { line: Math.max(0, pos.line - 1), character: Math.max(0, pos.col) };
}

export function normalizeLocations(r: null | Location | Location[] | LocationLink[]): { uri: string; range: Range }[] {
  if (!r) return [];
  const list = Array.isArray(r) ? r : [r];
  return list.map((x) => ('targetUri' in x ? { uri: x.targetUri, range: x.targetSelectionRange ?? x.targetRange } : x));
}

/**
 * The token type at `col` on `line` in a relative-encoded semantic token list, or null
 * between tokens. Tokens come as 5-tuples relative to the previous token: deltaLine,
 * deltaStart, length, type, modifiers.
 */
export function tokenAt(data: number[], line: number, col: number, tokenTypes: string[]): string | null {
  let tokLine = 0;
  let tokStart = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i]!;
    tokLine += deltaLine;
    tokStart = deltaLine === 0 ? tokStart + data[i + 1]! : data[i + 1]!;
    if (tokLine !== line || col < tokStart || col >= tokStart + data[i + 2]!) continue;
    return tokenTypes[data[i + 3]!] ?? null;
  }
  return null;
}

/** Either symbol shape a server may answer `documentSymbol` with, flattened in document order. */
export function flattenSymbols(result: DocumentSymbol[] | SymbolInformation[], path: string): LspSymbol[] {
  const out: LspSymbol[] = [];
  if (isDocumentSymbols(result)) {
    const walk = (syms: DocumentSymbol[], container?: string) => {
      for (const s of syms) {
        const start = (s.selectionRange ?? s.range).start;
        const endLine = Math.max(start.line, (s.range ?? s.selectionRange).end.line) + 1;
        out.push({ name: s.name, kind: s.kind, container, path, line: start.line + 1, endLine, col: start.character });
        if (s.children?.length) walk(s.children, s.name);
      }
    };
    walk(result);
    return out;
  }
  return result.map((s) => symbolInformation(s, path));
}

export function symbolInformation(s: SymbolInformation, path: string): LspSymbol {
  const start = 'range' in s.location ? s.location.range.start : { line: 0, character: 0 };
  const end = 'range' in s.location ? s.location.range.end : start;
  return {
    name: s.name,
    kind: s.kind,
    container: s.containerName || undefined,
    path,
    line: start.line + 1,
    endLine: Math.max(start.line, end.line) + 1,
    col: start.character,
  };
}

export function isDocumentSymbols(r: DocumentSymbol[] | SymbolInformation[]): r is DocumentSymbol[] {
  return r.length > 0 && !('location' in r[0]!);
}
