import type { LanguageId, LspMissing } from '../../shared/protocol.js';
import { argv0, findOnPath } from './which.js';

/** A server diffle knows how to start, and the languages it answers for. */
export interface ServerCandidate {
  languages: LanguageId[];
  /** Shell command line that starts it on stdio. */
  command: string;
  /** A second program that must be on PATH too: the one shipping a plugin `command` loads. */
  requires?: string;
  /**
   * Languages it answers for beside their owner, as an editor extension would: started
   * whenever one of them is in the diff, never counted as serving it, and running alone
   * for a language nothing owns.
   */
  joins?: LanguageId[];
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
  // Vue 3 language tools answer for .vue files from inside tsserver, through the plugin
  // that ships with vue-language-server; the TypeScript servers load it (configuration.ts).
  { languages: ['vue'], command: 'typescript-language-server --stdio', requires: 'vue-language-server' },
  { languages: ['vue'], command: 'vtsls --stdio', requires: 'vue-language-server' },
  // Needs a TypeScript to load, handed over at initialize (configuration.ts).
  { languages: ['astro'], command: 'astro-ls --stdio' },
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
  { languages: ['css'], command: 'vscode-css-language-server --stdio' },
  { languages: ['html'], command: 'vscode-html-language-server --stdio' },
  // Class hovers wherever Tailwind classes appear, beside whatever owns the file.
  {
    languages: [],
    joins: ['astro', 'css', 'html', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue'],
    command: 'tailwindcss-language-server --stdio',
  },
];

/** One process to start: its command and every language routed to it. */
export interface ResolvedServer {
  command: string;
  /** Languages it owns: it answers first and alone for highlights, tokens and outlines. */
  languages: LanguageId[];
  /** Languages it answers for beside their owner. */
  joins: LanguageId[];
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
 * process. A missing language's `tried` names the programs that were not on PATH, so
 * a candidate needing two programs lists only the absent one. A candidate joining a
 * requested language starts too, when on PATH, whatever owns it; its absence is no one's
 * missing server. `lookup` is a test seam for the PATH probe.
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
  const asked = [...new Set(languages)].sort();
  for (const language of asked) {
    let command = overrides[language]?.trim();
    // An empty override is a deliberate off switch, and names nothing to install.
    const tried: string[] = [];
    if (command == null) {
      for (const candidate of CANDIDATES) {
        if (!candidate.languages.includes(language)) continue;
        const absent = [candidate.command, candidate.requires]
          .filter((c): c is string => c != null && !found(c))
          .map(argv0);
        if (!absent.length) {
          command = candidate.command;
          break;
        }
        for (const program of absent) if (!tried.includes(program)) tried.push(program);
      }
    }
    if (command == null || command === '') {
      missing.push({ language, tried });
      continue;
    }
    const server = servers.get(command);
    if (server) server.languages.push(language);
    else servers.set(command, { command, languages: [language], joins: [] });
  }
  for (const candidate of CANDIDATES) {
    const joins = candidate.joins ?? [];
    if (!joins.some((l) => asked.includes(l))) continue;
    if (![candidate.command, candidate.requires].every((c) => c == null || found(c))) continue;
    const server = servers.get(candidate.command) ?? { command: candidate.command, languages: [], joins: [] };
    servers.set(candidate.command, server);
    for (const l of joins) if (!server.languages.includes(l) && !server.joins.includes(l)) server.joins.push(l);
  }
  return { servers: [...servers.values()], missing };
}
