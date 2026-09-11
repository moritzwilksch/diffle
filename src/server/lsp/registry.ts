import type { LanguageId, LspMissing } from '../../shared/protocol.js';
import { argv0, findOnPath } from './which.js';

/** A server diffle knows how to start, and the languages it answers for. */
export interface ServerCandidate {
  languages: LanguageId[];
  /** Shell command line that starts it on stdio. */
  command: string;
}

/**
 * Built-in servers, in preference order per language: the first one whose program is
 * on PATH is used. Entries serving several languages become one process, which is how
 * the servers themselves want it (clangd for c and cpp, tsserver for all of js/ts).
 */
export const CANDIDATES: ServerCandidate[] = [
  { languages: ['python'], command: 'pyrefly lsp' },
  { languages: ['python'], command: 'ty server' },
  { languages: ['python'], command: 'basedpyright-langserver --stdio' },
  { languages: ['python'], command: 'pyright-langserver --stdio' },
  { languages: ['python'], command: 'pylsp' },
  { languages: ['python'], command: 'jedi-language-server' },
  {
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    command: 'typescript-language-server --stdio',
  },
  { languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'], command: 'vtsls --stdio' },
  { languages: ['rust'], command: 'rust-analyzer' },
  { languages: ['go'], command: 'gopls' },
  { languages: ['c', 'cpp'], command: 'clangd' },
  { languages: ['ruby'], command: 'ruby-lsp' },
  { languages: ['ruby'], command: 'solargraph stdio' },
  { languages: ['java'], command: 'jdtls' },
  { languages: ['lua'], command: 'lua-language-server' },
  { languages: ['nix'], command: 'nixd' },
  { languages: ['nix'], command: 'nil' },
  { languages: ['zig'], command: 'zls' },
  { languages: ['swift'], command: 'sourcekit-lsp' },
  { languages: ['php'], command: 'intelephense --stdio' },
  { languages: ['php'], command: 'phpactor language-server' },
  { languages: ['shellscript'], command: 'bash-language-server start' },
  { languages: ['haskell'], command: 'haskell-language-server-wrapper --lsp' },
  { languages: ['ocaml'], command: 'ocamllsp' },
  { languages: ['terraform'], command: 'terraform-ls serve' },
  { languages: ['json', 'jsonc'], command: 'vscode-json-language-server --stdio' },
  { languages: ['json', 'jsonc'], command: 'vscode-json-languageserver --stdio' },
  { languages: ['yaml'], command: 'yaml-language-server --stdio' },
  { languages: ['toml'], command: 'tombi lsp' },
  { languages: ['toml'], command: 'taplo lsp stdio' },
];

/** One process to start: its command and every language routed to it. */
export interface ResolvedServer {
  command: string;
  languages: LanguageId[];
}

export interface Resolution {
  servers: ResolvedServer[];
  /** Languages nothing on PATH can serve. A language turned off by config is absent from both lists. */
  missing: LspMissing[];
}

/** The candidate commands for a language, in the order they are tried. */
export function candidatesFor(language: LanguageId): string[] {
  return CANDIDATES.filter((c) => c.languages.includes(language)).map((c) => c.command);
}

/**
 * Which servers to start for `languages`. A config override replaces the candidate
 * list for its language and is never probed: the user named a command, so a typo
 * should surface as the server failing to start, not as silence. An override of `''`
 * turns the language off. Languages resolving to the same command line share one
 * process. `lookup` is a test seam for the PATH probe.
 */
export function resolveServers(
  languages: Iterable<LanguageId>,
  overrides: Partial<Record<LanguageId, string>> = {},
  lookup: (command: string) => string | null = (c) => findOnPath(c),
): Resolution {
  const probe = new Map<string, boolean>();
  const found = (command: string): boolean => {
    let hit = probe.get(command);
    if (hit == null) probe.set(command, (hit = lookup(command) != null));
    return hit;
  };
  const servers = new Map<string, ResolvedServer>();
  const missing: LspMissing[] = [];
  // Sorted so the status, the startup line and `diffle lsp` list servers the same way every run.
  for (const language of [...new Set(languages)].sort()) {
    const override = overrides[language]?.trim();
    const command = override ?? candidatesFor(language).find(found);
    if (command == null || command === '') {
      // An empty override is a deliberate off switch, and names nothing to install.
      missing.push({ language, tried: command === '' ? [] : candidatesFor(language).map(argv0) });
      continue;
    }
    const server = servers.get(command);
    if (server) server.languages.push(language);
    else servers.set(command, { command, languages: [language] });
  }
  return { servers: [...servers.values()], missing };
}
