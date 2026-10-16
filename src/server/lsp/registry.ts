import type { LanguageId, LspFeature, LspMissing } from '../../shared/protocol.js';
import { loadSchemaCatalog, SCHEMA_CATALOG, type LspSettings } from './configuration.js';
import { tsdkLocation } from './tsdk.js';
import { VUE_PLUGIN, vuePlugin, vuePluginLocation } from './vue.js';
import { argv0, findOnPath, programOf } from './which.js';

/** What a server's settings may depend on. */
export interface ServerContext {
  /** Repository root: the workspace folder. */
  root: string;
  /** The PATH probe; a test seam. */
  lookup: (command: string) => string | null;
}

/** How one language server is started and configured: everything diffle knows about it, in one place. */
export interface ServerDefinition {
  /** Shell command line that starts it on stdio. */
  command: string;
  /** Settings sent after initialization and answered to `workspace/configuration`. */
  settings?: (ctx: ServerContext) => LspSettings | Promise<LspSettings>;
  /** Sent with `initialize`, for servers configured there rather than through settings. */
  initializationOptions?: (ctx: ServerContext) => LspSettings | undefined;
  /** Features the server answers without ever advertising them; asked for as if it had. */
  assumes?: LspFeature[];
}

/** A second program a candidate needs on PATH, and what `command` loads from beside it. */
export interface Requirement {
  program: string;
  /** What `program` ships for `command`, as messages name it. */
  what: string;
  /** Where that sits, given `program`'s executable; null when it cannot be found beside it. */
  locate: (executable: string) => string | null;
}

/** A server diffle knows how to start, and the languages it answers for. */
export interface ServerCandidate extends ServerDefinition {
  languages: LanguageId[];
  /** A second program that must be on PATH too, with what `command` loads from beside it in reach. */
  requires?: Requirement;
  /**
   * Languages it answers for beside their owner, as an editor extension would: started
   * whenever one of them is in the diff, never counted as serving it, and running alone
   * for a language nothing owns.
   */
  joins?: LanguageId[];
}

const TYPESCRIPT: LanguageId[] = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];

// typescript-language-server loads tsserver plugins from initializationOptions.
const TSSERVER: ServerDefinition = {
  command: 'typescript-language-server --stdio',
  initializationOptions: ({ lookup }) => {
    const plugin = vuePlugin(lookup);
    return plugin ? { plugins: [plugin] } : undefined;
  },
};

// vtsls takes tsserver plugins as settings; the namespace is where Vue's plugin reads its options.
const VTSLS: ServerDefinition = {
  command: 'vtsls --stdio',
  settings: ({ lookup }) => {
    const plugin = vuePlugin(lookup);
    return plugin ? { vtsls: { tsserver: { globalPlugins: [{ ...plugin, configNamespace: 'typescript' }] } } } : {};
  },
};

const VUE: Requirement = { program: 'vue-language-server', what: VUE_PLUGIN, locate: vuePluginLocation };

/**
 * Built-in servers, in preference order per language: the first one whose program is
 * on PATH is used. Entries serving several languages become one process, which is how
 * the servers themselves want it (clangd for c and cpp, tsserver for all of js/ts).
 */
export const CANDIDATES: ServerCandidate[] = [
  // pyrefly answers semantic token requests without advertising the provider.
  { languages: ['python'], command: 'pyrefly lsp', assumes: ['semanticTokens'] },
  { languages: ['python'], command: 'ty server' },
  { languages: ['python'], command: 'basedpyright-langserver --stdio' },
  { languages: ['python'], command: 'pyright-langserver --stdio' },
  { languages: ['python'], command: 'pylsp' },
  { languages: ['python'], command: 'jedi-language-server' },
  { languages: TYPESCRIPT, ...TSSERVER },
  { languages: TYPESCRIPT, ...VTSLS },
  // Vue 3 language tools answer for .vue files from inside tsserver, through the plugin
  // that ships with vue-language-server; the TypeScript servers load it (vue.ts).
  { languages: ['vue'], ...TSSERVER, requires: VUE },
  { languages: ['vue'], ...VTSLS, requires: VUE },
  {
    languages: ['astro'],
    command: 'astro-ls --stdio',
    // Without a tsdk the server refuses to initialize; its own message then names the option.
    initializationOptions: ({ root, lookup }) => {
      const tsdk = tsdkLocation(
        root,
        ['astro-ls', 'typescript-language-server', 'vtsls'].map((c) => lookup(c)),
      );
      return tsdk ? { typescript: { tsdk } } : undefined;
    },
  },
  { languages: ['rust'], command: 'rust-analyzer' },
  { languages: ['go'], command: 'gopls' },
  { languages: ['c', 'cpp'], command: 'clangd' },
  { languages: ['ruby'], command: 'ruby-lsp' },
  { languages: ['ruby'], command: 'solargraph stdio' },
  { languages: ['java'], command: 'jdtls' },
  // Roslyn loads no project unless asked, and C# answers little without the solution behind the file.
  { languages: ['csharp'], command: 'roslyn-language-server --stdio --autoLoadProjects' },
  // The pinned nixpkgs roslyn-ls package exposes the assembly name.
  { languages: ['csharp'], command: 'Microsoft.CodeAnalysis.LanguageServer --stdio --autoLoadProjects' },
  { languages: ['csharp'], command: 'csharp-ls' },
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
  {
    languages: ['json', 'jsonc'],
    command: 'vscode-json-language-server --stdio',
    settings: async () => ({ json: { schemas: await loadSchemaCatalog() } }),
  },
  {
    languages: ['json', 'jsonc'],
    command: 'vscode-json-languageserver --stdio',
    settings: async () => ({ json: { schemas: await loadSchemaCatalog() } }),
  },
  {
    languages: ['yaml'],
    command: 'yaml-language-server --stdio',
    settings: () => ({ yaml: { hover: true, schemaStore: { enable: true, url: SCHEMA_CATALOG } } }),
  },
  { languages: ['toml'], command: 'tombi lsp' },
  {
    languages: ['toml'],
    command: 'taplo lsp stdio',
    settings: () => ({ evenBetterToml: { schema: { enabled: true, catalogs: [SCHEMA_CATALOG] } } }),
  },
  {
    languages: ['css'],
    command: 'vscode-css-language-server --stdio',
    // Diagnostics go unread, and the server's linter crashes on a missing `lint` section.
    settings: () => ({ css: { validate: false }, less: { validate: false }, scss: { validate: false } }),
  },
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
 * How a command line's program is configured, by the built-in definition for that program:
 * an override naming a known server with other flags or a full path still gets its
 * settings. A program diffle does not know takes none.
 */
export function definitionOf(command: string): ServerDefinition {
  const program = programOf(command);
  const known = CANDIDATES.find((c) => programOf(c.command) === program);
  return {
    command,
    settings: known?.settings,
    initializationOptions: known?.initializationOptions,
    assumes: known?.assumes,
  };
}

/**
 * Which servers to start for `languages`. A config override replaces the candidate
 * list for its language and is never probed: the user named a command, so a typo
 * should surface as the server failing to start, not as silence. An override of `''`
 * turns the language off. Languages resolving to the same command line share one
 * process. A missing language's `tried` names the programs that were not on PATH, so
 * a candidate needing two programs lists only the absent one; a program on PATH that
 * lacks what the candidate loads from beside it is as good as absent, and the first
 * such finding is the language's `why`. A candidate joining a requested language
 * starts too, when on PATH, whatever owns it, and joins only the requested ones,
 * growing like an owner does as later snapshots ask for more; its absence is no one's
 * missing server. `lookup` is a test seam for the PATH probe.
 */
export function resolveServers(
  languages: Iterable<LanguageId>,
  overrides: Partial<Record<LanguageId, string>> = {},
  lookup: (command: string) => string | null = (c) => findOnPath(c),
): Resolution {
  const probed = new Map<string, string | null>();
  const where = (command: string): string | null => {
    let hit = probed.get(command);
    if (hit === undefined) probed.set(command, (hit = lookup(command)));
    return hit;
  };
  /** What keeps a candidate from starting: programs not on PATH, or one on PATH without what it loads from beside it. */
  const probe = (candidate: ServerCandidate): { absent: string[]; why?: string } => {
    const absent: string[] = [];
    if (where(candidate.command) == null) absent.push(argv0(candidate.command));
    const { requires } = candidate;
    if (!requires) return { absent };
    const executable = where(requires.program);
    if (executable == null) absent.push(requires.program);
    else if (requires.locate(executable) == null)
      return { absent, why: `${requires.program} is on PATH but ${requires.what} was not found beside it` };
    return { absent };
  };
  const startable = (candidate: ServerCandidate): boolean => {
    const { absent, why } = probe(candidate);
    return !absent.length && !why;
  };
  const servers = new Map<string, ResolvedServer>();
  const missing: LspMissing[] = [];
  // Sorted so the status, the startup line and `diffle lsp` list servers the same way every run.
  const asked = [...new Set(languages)].sort();
  for (const language of asked) {
    let command = overrides[language]?.trim();
    // An empty override is a deliberate off switch, and names nothing to install.
    const tried: string[] = [];
    let why: string | undefined;
    if (command == null) {
      for (const candidate of CANDIDATES) {
        if (!candidate.languages.includes(language)) continue;
        const { absent, why: broken } = probe(candidate);
        if (!absent.length && !broken) {
          command = candidate.command;
          break;
        }
        why ??= broken;
        for (const program of absent) if (!tried.includes(program)) tried.push(program);
      }
    }
    if (command == null || command === '') {
      missing.push(why ? { language, tried, why } : { language, tried });
      continue;
    }
    const server = servers.get(command);
    if (server) server.languages.push(language);
    else servers.set(command, { command, languages: [language], joins: [] });
  }
  for (const candidate of CANDIDATES) {
    const joins = (candidate.joins ?? []).filter((l) => asked.includes(l));
    if (!joins.length || !startable(candidate)) continue;
    const server = servers.get(candidate.command) ?? { command: candidate.command, languages: [], joins: [] };
    servers.set(candidate.command, server);
    for (const l of joins) if (!server.languages.includes(l) && !server.joins.includes(l)) server.joins.push(l);
  }
  return { servers: [...servers.values()], missing };
}
