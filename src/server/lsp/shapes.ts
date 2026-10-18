import type { LspFeature, LspPosition, LspSymbol } from '../../shared/protocol.js';
import type { Range } from './Locator.js';

/**
 * Token types by index when the server publishes no legend. The LSP spec's own
 * enumeration; pyrefly numbers its tokens this way.
 */
export const DEFAULT_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
];

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
  semanticTokens: { provider: 'semanticTokensProvider', method: 'textDocument/semanticTokens' },
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
 * server that advertises after `initialize` (semantic tokens, often) is still asked.
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
    semanticTokens: {
      dynamicRegistration: true,
      requests: { range: true },
      tokenTypes: DEFAULT_TOKEN_TYPES,
      tokenModifiers: [],
      formats: ['relative'],
    },
  },
  // A refresh is honored trivially: token kinds are asked for afresh on every use.
  workspace: {
    symbol: { dynamicRegistration: true },
    workspaceFolders: true,
    configuration: true,
    semanticTokens: { refreshSupport: true },
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
