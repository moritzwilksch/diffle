import type { LspFeature, LspPosition, LspSymbol } from '@/shared/protocol.js';
import type { Range } from './Locator.js';

/**
 * How a server advertises each feature: the `initialize` capability (a boolean or an
 * options object) and the method a later `client/registerCapability` names.
 */
export const FEATURES: Record<LspFeature, { provider: string; method: string }> = {
  definition: { provider: 'definitionProvider', method: 'textDocument/definition' },
  typeDefinition: { provider: 'typeDefinitionProvider', method: 'textDocument/typeDefinition' },
  hover: { provider: 'hoverProvider', method: 'textDocument/hover' },
  references: { provider: 'referencesProvider', method: 'textDocument/references' },
  documentSymbol: { provider: 'documentSymbolProvider', method: 'textDocument/documentSymbol' },
  workspaceSymbol: { provider: 'workspaceSymbolProvider', method: 'workspace/symbol' },
  documentHighlight: { provider: 'documentHighlightProvider', method: 'textDocument/documentHighlight' },
};

/** The feature a registration's method names, or null for one diffle never asks for. */
export function featureOf(method: string): LspFeature | null {
  for (const [feature, { method: m }] of Object.entries(FEATURES) as [LspFeature, { method: string }][])
    if (m === method) return feature;
  return null;
}

/**
 * What diffle tells a server it can do. Every feature allows dynamic registration, so a
 * server that advertises after `initialize` is still asked.
 */
export const CLIENT_CAPABILITIES = {
  window: { workDoneProgress: true },
  textDocument: {
    synchronization: { didSave: false },
    definition: { dynamicRegistration: true, linkSupport: true },
    typeDefinition: { dynamicRegistration: true, linkSupport: true },
    references: { dynamicRegistration: true },
    documentHighlight: { dynamicRegistration: true },
    hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
    documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
  },
  workspace: {
    symbol: { dynamicRegistration: true },
    workspaceFolders: true,
    configuration: true,
  },
};

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

/** `answer` as is, or with why it may be incomplete when it is `empty` and the server was `busy`. */
export function inconclusive<T extends object>(
  answer: T,
  empty: boolean,
  busy: string | null,
): T & { inconclusive?: string } {
  return busy && empty ? { ...answer, inconclusive: busy } : answer;
}

export function toLsp(pos: LspPosition): { line: number; character: number } {
  return { line: Math.max(0, pos.line - 1), character: Math.max(0, pos.col) };
}

/** An LSP range as diffle spans it: 1-based lines, 0-based columns. */
export function fromLsp({ start, end }: Range): { line: number; col: number; endLine: number; endCol: number } {
  return { line: start.line + 1, col: start.character, endLine: end.line + 1, endCol: end.character };
}

export function normalizeLocations(r: null | Location | Location[] | LocationLink[]): { uri: string; range: Range }[] {
  if (!r) return [];
  const list = Array.isArray(r) ? r : [r];
  return list.map((x) => ('targetUri' in x ? { uri: x.targetUri, range: x.targetSelectionRange ?? x.targetRange } : x));
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
