// How the client and the server decide, from one status, what a language-server query can do.
import {
  followsCheckout,
  languageOf,
  type LanguageId,
  type LspFeature,
  type LspServerStatus,
  type LspStatus,
  type Snapshot,
} from './protocol.js';

/** How messages name a feature: "pyrefly offers no go to definition". */
export const LSP_FEATURE_LABELS: Record<LspFeature, string> = {
  definition: 'go to definition',
  typeDefinition: 'go to type definition',
  hover: 'hover',
  references: 'references',
  documentSymbol: 'document symbols',
  workspaceSymbol: 'workspace symbols',
  semanticTokens: 'semantic tokens',
  documentHighlight: 'document highlights',
};

export interface LspQuery {
  /** The file asked about; without one, the request is repository-wide. */
  path?: string;
  feature?: LspFeature;
  /** Let a starting server through: the pool waits for it to initialize, where the client would only flash. */
  patient?: boolean;
}

/**
 * Why no language server can answer the query right now, and null when one can. The one
 * place that reasons about the run, the snapshot and the servers together, so the
 * client's flash and the API's 409 say the same thing. A null `snap` is one not loaded yet.
 */
export function lspBlocker(
  lsp: LspStatus,
  snap: Pick<Snapshot, 'newSha' | 'headSha'> | null,
  { path, feature, patient = false }: LspQuery = {},
): string | null {
  if (!lsp.enabled) return 'Language servers are off for this run (--no-lsp)';
  if (!snap || !followsCheckout(snap))
    return 'Symbol navigation needs the new side to be the worktree or the checked-out commit';
  let servers = lsp.servers;
  let language: LanguageId | undefined;
  if (path != null) {
    language = languageOf(path) ?? undefined;
    if (!language) return `No language server for ${/(\.[^./\\]+)$/.exec(path)?.[1] ?? 'these'} files`;
    servers = serversFor(lsp, language);
  }
  if (!servers.length) return noServer(lsp, language);
  // A starting server has not said what it offers yet, so it may still answer.
  const able = feature ? servers.filter((s) => s.state === 'starting' || s.supports.includes(feature)) : servers;
  if (!able.length) return `${servers.map((s) => s.name).join(', ')} offers no ${LSP_FEATURE_LABELS[feature!]}`;
  return able.some((s) => s.state === 'ready' || (patient && s.state === 'starting')) ? null : notReady(able[0]!);
}

/** The servers answering for `language`, its owners before the ones joining it. */
export function serversFor(lsp: LspStatus, language: LanguageId): LspServerStatus[] {
  return [
    ...lsp.servers.filter((s) => s.languages.includes(language)),
    ...lsp.servers.filter((s) => s.joins.includes(language)),
  ];
}

/**
 * Whether the file's servers offer hover and nothing to navigate by: the schema servers for
 * configuration files. Such a file gets tooltips on any token and no symbol menu.
 */
export function hoverOnly(lsp: LspStatus, path: string): boolean {
  const language = languageOf(path);
  const ready = language ? serversFor(lsp, language).filter((s) => s.state === 'ready') : [];
  return ready.length > 0 && ready.every((s) => !s.supports.some((f) => f === 'definition' || f === 'references'));
}

/** Whether `server` answers for `language`, as its owner or beside one. */
export function serves(server: LspServerStatus, language: LanguageId): boolean {
  return server.languages.includes(language) || server.joins.includes(language);
}

/** Whether a running server joins `language` beside its owner, and so may answer where the owner would not. */
export function joinedBy(lsp: LspStatus, language: LanguageId): boolean {
  return lsp.servers.some((s) => s.state === 'ready' && s.joins.includes(language));
}

/** A server's languages for a status line: the ones it owns, then the ones it joins marked `+`. */
export function languagesLabel(server: Pick<LspServerStatus, 'languages' | 'joins'>): string {
  return [...server.languages, ...server.joins.map((l) => `+${l}`)].join(', ');
}

function notReady(s: LspServerStatus): string {
  return s.state === 'starting'
    ? `${s.name} is starting…`
    : `${s.name} is unavailable: ${s.message ?? 'unknown error'}`;
}

/** No server serves `language` (or nothing runs at all): say what the reader can do about it. */
function noServer(lsp: LspStatus, language?: LanguageId): string {
  const missing = language == null ? lsp.missing : lsp.missing.filter((m) => m.language === language);
  // A broken installation is the one thing installing something else will not fix.
  const broken = missing.find((m) => m.why);
  if (broken) return `No language server for ${broken.language}: ${broken.why}`;
  const absent = missing.filter((m) => m.tried.length > 0);
  const off = missing.filter((m) => m.tried.length === 0).map((m) => m.language);
  if (absent.length) {
    const langs = [...new Set(absent.map((m) => m.language))].join(', ');
    const programs = [...new Set(absent.flatMap((m) => m.tried))].join(', ');
    return `No language server for ${langs} on PATH: install one of ${programs}`;
  }
  if (off.length) return `The language server for ${off.join(', ')} is off in your diffle config`;
  return language == null ? 'No language server runs for this diff' : `No language server runs for ${language}`;
}
