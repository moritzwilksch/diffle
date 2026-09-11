#!/usr/bin/env node
import { Argument, Command, CommanderError, Option } from 'commander';
import { completionHint } from 'commander-static-completion';
import pkg from '../../package.json' with { type: 'json' };
import { formatPrompt } from '../server/comments/format.js';
import { GitError, GitRepo } from '../server/git/GitRepo.js';
import { GithubError } from '../server/github.js';
import { LspPool } from '../server/lsp/LspPool.js';
import { resolveServers } from '../server/lsp/registry.js';
import { RevspecError } from '../server/revspec.js';
import { DEFAULT_PORT, hasClientBuild, Server } from '../server/Server.js';
import { Session } from '../server/Session.js';
import { UserConfigStore } from '../server/UserConfig.js';
import { WsHub } from '../server/ws.js';
import {
  comparisonLabel,
  followsCheckout,
  LANGUAGE_IDS,
  type LanguageId,
  type ModeRequest,
  type UserConfig,
} from '../shared/protocol.js';
import {
  collectLanguage,
  collectLspOverride,
  type LspOverride,
  parseContext,
  parseLanguage,
  parsePort,
} from './args.js';
import { watchBrowserLifetime } from './browserLifetime.js';
import { addCompletionCommand } from './completion.js';
import { openBrowser } from './open.js';
import { openReviewRepository } from './repository.js';
import { Timing } from './timing.js';

/** Minimal ANSI colors; off when stderr is not a TTY or NO_COLOR is set. */
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const c = {
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
  bold: paint('1'),
  dim: paint('2'),
};

interface GlobalOpts {
  C?: string;
  /** Unset: DEFAULT_PORT, or the next free one. */
  port?: number;
  host: string;
  open: boolean;
  keepAlive: boolean;
  watch: boolean;
  timing: boolean;
  dev?: boolean;
  autoViewed: string[];
  context?: number;
  /** false: `--no-lsp`. true: a bare `--lsp`, which is the default anyway. Else per-language overrides. */
  lsp: boolean | LspOverride[];
}

const program = new Command()
  .name('diffle')
  .description('Review a git diff in the browser and export line comments as an agent prompt.')
  .version(pkg.version, '-v, --version', 'print the version and exit')
  .addOption(
    completionHint(new Option('-C <path>', 'run as if started in <path> (any directory inside a git worktree)'), {
      kind: 'directory',
    }),
  )
  .option(
    '-p, --port <port>',
    `port to listen on (default: ${DEFAULT_PORT}, or the next free one; 0 = random)`,
    parsePort,
  )
  .option('-H, --host <host>', 'address to bind; use 0.0.0.0 to expose on the network', '127.0.0.1')
  .option('--no-open', 'do not open a browser')
  .option('--keep-alive', 'keep the server running after all browser tabs close')
  .option('--no-watch', 'do not watch for changes')
  .addOption(
    new Option('--auto-viewed <glob>', 'mark matching files viewed for this session (repeatable)')
      .argParser(collect)
      .default([], 'none'),
  )
  .option('-U, --context <n>', 'context lines around changes for this session (default: config, 5)', parseContext)
  .addOption(
    // The value is required. Servers are on by default, so a value-less `--lsp` would mean
    // nothing, and commander skips the parser for a missing optional value: it would store
    // `true` over the overrides an earlier `--lsp` named.
    new Option(
      '--lsp <language=command>',
      "language server command for one language, started for this run (repeatable); by default the diff's languages are served by whatever is on PATH",
    )
      .argParser(collectLspOverride)
      .default(true, "the diff's languages, resolved on PATH"),
  )
  .option('--no-lsp', 'do not start any language server')
  .option('--timing', 'print startup phase timings to stderr')
  .option('--dev', 'serve the client through Vite (development)', process.env.DIFFLE_DEV === '1' ? true : undefined)
  .addArgument(
    // The shorthands are hidden commands, so completion would never offer them; naming them
    // here keeps the two most common invocations one Tab away. Revisions come from git, which
    // a static completion script cannot ask.
    completionHint(new Argument('[revs...]', 'git-diff style revisions: <rev> | <a>..<b> | <a>...<b> | <a> <b>'), {
      kind: 'choices',
      values: ['working', 'pr'],
    }),
  )
  .addHelpText(
    'after',
    `
Shorthands (in place of <revs>):
  working                  same as HEAD..worktree: uncommitted changes, staged and untracked included
  pr [number|url]          a GitHub pull request: its base...head, fetched if needed
                           (without an argument: the pull request for this branch)

Revisions follow git diff, except that a lone one compares from the merge base:
  diffle main              same as main...HEAD: what this branch added since it left main
  diffle HEAD~3            the last three commits
  diffle main..feat        main vs feat
  diffle main...feat       what feat added since it left main
  diffle main..worktree    main vs the uncommitted tree ("worktree" works on either side)

Status goes to stderr, so stdout carries only the review: unless --keep-alive is set,
closing the last auto-opened browser tab stops diffle and prints the open comments as a prompt for an agent.
Ctrl+C always stops it.`,
  )
  .action(async (revs: string[], _o, cmd: Command) => {
    if (revs.length === 0) cmd.help();
    await run({ kind: 'revspec', args: revs }, cmd.optsWithGlobals<GlobalOpts>());
  });

// Shorthands name what to compare, not commands, so help lists them separately.
program
  .command('working', { hidden: true })
  .summary('same as HEAD..worktree')
  .description('Same as `diffle HEAD..worktree`: uncommitted changes, staged and untracked files included.')
  .action(async (_o, cmd: Command) => run({ kind: 'working' }, cmd.optsWithGlobals<GlobalOpts>()));

program
  .command('pr', { hidden: true })
  .argument('[pr]', 'pull request number or url; default: the pull request for this branch')
  .summary('a GitHub pull request')
  .description('A GitHub pull request, as GitHub shows it: merge-base(base, head) vs head.')
  .action(async (pr: string | undefined, _o, cmd: Command) =>
    run({ kind: 'pr', pr }, cmd.optsWithGlobals<GlobalOpts>()),
  );

const config = program.command('config').description('show or edit the user config (same settings as the UI dialog)');
config
  .command('show', { isDefault: true })
  .description('print the config file path and contents')
  .action(async () => {
    const store = await UserConfigStore.open();
    console.log(`# ${store.file}`);
    console.log(JSON.stringify(store.get(), null, 2));
  });
config
  .command('add-auto-viewed')
  .description('add patterns for files that start viewed')
  .argument('<glob...>', 'patterns for files that start viewed and collapsed, e.g. "*.lock"')
  .action(async (globs: string[]) => {
    const store = await UserConfigStore.open();
    await store.set({ autoViewed: [...new Set([...store.get().autoViewed, ...globs])] });
    console.log(store.get().autoViewed.join('\n'));
  });
config
  .command('set-context')
  .description('set context lines around changes')
  .argument('<n>', 'context lines around changes', parseContext)
  .action(async (n: number) => {
    const store = await UserConfigStore.open();
    await store.set({ contextLines: n });
    console.log(store.get().contextLines);
  });
config
  .command('set-lsp')
  .description('set the language-server command for one language')
  .addArgument(languageArgument('<language>', `one of: ${LANGUAGE_IDS.join(', ')}`).argParser(parseLanguage))
  .argument('<command>', 'shell command that starts a stdio language server, e.g. "pyrefly lsp"; "" to turn it off')
  .action(async (language: LanguageId, command: string) => {
    const store = await UserConfigStore.open();
    await store.set({ lspCommands: { ...store.get().lspCommands, [language]: command } });
    printLspCommands(store.get());
  });
config
  .command('unset-lsp')
  .description('forget a language-server override, back to PATH')
  .addArgument(
    languageArgument('<language...>', `one or more of: ${LANGUAGE_IDS.join(', ')}`).argParser(collectLanguage),
  )
  .action(async (languages: LanguageId[]) => {
    const store = await UserConfigStore.open();
    const drop = new Set(languages);
    await store.set({
      lspCommands: Object.fromEntries(
        Object.entries(store.get().lspCommands).filter(([l]) => !drop.has(l as LanguageId)),
      ),
    });
    printLspCommands(store.get());
  });
config
  .command('remove-auto-viewed')
  .description('remove patterns for files that start viewed')
  .argument('<glob...>')
  .action(async (globs: string[]) => {
    const store = await UserConfigStore.open();
    await store.set({ autoViewed: store.get().autoViewed.filter((g) => !globs.includes(g)) });
    console.log(store.get().autoViewed.join('\n'));
  });

program
  .command('lsp')
  .description('show the language server each language would get, and what is missing from PATH')
  .action(async () => {
    const { lspCommands } = (await UserConfigStore.open()).get();
    // The resolver decides, this only prints: what a run would start, said the same way.
    const { servers, missing } = resolveServers(LANGUAGE_IDS, lspCommands);
    const answer = new Map<LanguageId, string>();
    for (const s of servers)
      for (const language of s.languages)
        answer.set(language, `${s.command}${lspCommands[language] == null ? '' : c.dim(' (config)')}`);
    // An empty override is off, and names nothing to install: the resolver leaves `tried` empty.
    for (const m of missing)
      answer.set(m.language, c.dim(m.tried.length ? `not on PATH (tried ${m.tried.join(', ')})` : 'off in config'));
    const width = Math.max(...LANGUAGE_IDS.map((l) => l.length));
    for (const language of LANGUAGE_IDS) console.log(`${language.padEnd(width)}  ${answer.get(language) ?? ''}`);
  });

addCompletionCommand(program);

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

/** A `<language>` argument, completing to the languages diffle knows. */
function languageArgument(name: string, description: string): Argument {
  return completionHint(new Argument(name, description), { kind: 'choices', values: LANGUAGE_IDS });
}

function printLspCommands(config: UserConfig): void {
  for (const [language, command] of Object.entries(config.lspCommands)) console.log(`${language}=${command}`);
}

async function run(req: ModeRequest, opts: GlobalOpts): Promise<void> {
  const timing = new Timing(opts.timing);
  // A signal during cloning must let git settle before removing its destination.
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let review: Awaited<ReturnType<typeof openReviewRepository>> | undefined;
  try {
    review = await openReviewRepository(req, opts.C ?? process.cwd());
    timing.mark('open repository');
    const config = await UserConfigStore.open();
    if (interrupted) {
      await review.close();
      return;
    }
    await serve(req, opts, review.repo, review.close, config, timing);
  } catch (e) {
    await review?.close();
    throw e;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

async function serve(
  req: ModeRequest,
  opts: GlobalOpts,
  repo: GitRepo,
  closeRepo: () => Promise<void>,
  config: UserConfigStore,
  timing: Timing,
): Promise<void> {
  const hub = new WsHub();
  const session = new Session(repo, hub, { watch: opts.watch, context: opts.context ?? config.get().contextLines });
  // A `--lsp` override outranks the config and starts its server whatever the diff holds.
  const named = Array.isArray(opts.lsp) ? opts.lsp : [];
  const overrides = { ...config.get().lspCommands, ...Object.fromEntries(named.map((o) => [o.language, o.command])) };
  const lsp =
    opts.lsp === false
      ? null
      : startLsp(
          repo,
          session,
          hub,
          overrides,
          named.map((o) => o.language),
        );
  const server = new Server(
    { session, config, extraAutoViewed: opts.autoViewed, hub, lsp },
    { port: opts.port ?? DEFAULT_PORT, probe: opts.port == null, host: opts.host, dev: opts.dev || !hasClientBuild() },
  );
  let stopBrowserWatch = () => {};
  // Every long-lived resource goes through one release, whatever ends the run: a
  // signal, a usage error, or a failure such as an occupied port. Wait for git
  // before deleting its refs or clone; bound socket and LSP shutdown separately.
  const dispose = () => {
    stopBrowserWatch();
    return Promise.all([
      session.close(),
      Promise.race([
        Promise.allSettled([server.close(), lsp?.close()]),
        new Promise((res) => setTimeout(res, 1500).unref()),
      ]),
    ]).then(closeRepo);
  };

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.error(`\n👋 ${c.dim('shutting down')}`);
    // The handoff: the open threads, as a prompt, on stdout. Nothing else in this
    // path may write there.
    try {
      process.stdout.write(formatPrompt(session.comments.threads({ state: 'open' })));
    } catch {
      /* the session never became ready */
    }
    void dispose().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  stopBrowserWatch = watchBrowserLifetime(hub, opts.open && !opts.keepAlive, shutdown);

  try {
    // Bind and open the browser before any further git work.
    const url = await server.listen();
    timing.mark('listen');
    if (opts.open) {
      const browserUrl = new URL(url);
      if (opts.host === '0.0.0.0' || opts.host === '::') browserUrl.hostname = 'localhost';
      openBrowser(browserUrl.href);
    }
    console.error(`🚀 diffle running at ${c.cyan(url.href)}`);
    console.error(`📂 ${c.dim('repo')} ${repo.root}`);

    const snap = await session.start(req);
    timing.mark('snapshot');
    const n = snap.changed.length;
    const adds = snap.changed.reduce((a, f) => a + f.additions, 0);
    const dels = snap.changed.reduce((a, f) => a + f.deletions, 0);
    console.error(`🔍 ${c.dim('comparing')} ${c.bold(comparisonLabel(snap.mode))}`);
    if (n === 0) console.error(`${c.yellow('!')} No differences. Open any file from the tree to comment on it.`);
    else console.error(`📝 ${n} changed file${n === 1 ? '' : 's'}  ${c.green(`+${adds}`)} ${c.red(`−${dels}`)}`);
    if (snap.mode.live !== 'none')
      console.error(
        `👀 ${c.dim(snap.mode.live === 'worktree' ? 'watching the worktree' : 'watching refs')}${opts.watch ? '' : c.dim(' (disabled with --no-watch)')}`,
      );
    if (lsp) {
      const { servers, missing } = lsp.status();
      const names = servers.map((s) => `${s.name} ${c.dim(`(${s.languages.join(', ')})`)}`).join(', ');
      if (!followsCheckout(snap))
        console.error(`🧭 ${c.dim('no language server: symbol navigation needs the new side to be the checkout')}`);
      else console.error(`🧭 ${c.dim('lsp')} ${names || c.dim('no language server for this diff')}`);
      // Languages turned off in the config stay quiet; a missing program is worth saying once.
      for (const m of missing.filter((m) => m.tried.length))
        console.error(`${c.yellow('!')} no ${m.language} language server ${c.dim(`(tried ${m.tried.join(', ')})`)}`);
    }
    timing.report();
  } catch (e) {
    await dispose();
    if (e instanceof RevspecError || e instanceof GitError || e instanceof GithubError) {
      console.error(`${c.red('✖')} ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

/**
 * The pool reads new-side text through the session, so the snapshot allowlist applies to
 * every LSP path. Each snapshot decides which languages run: it re-opens the diff's files
 * in the server for their language, so references in them are found from the reviewed text
 * (see LspPool.track). Nothing starts when the new side is not the checkout: the client
 * refuses symbol navigation there, and a server would otherwise see text that contradicts
 * the disk it indexes.
 */
function startLsp(
  repo: GitRepo,
  session: Session,
  hub: WsHub,
  overrides: Partial<Record<LanguageId, string>>,
  preload: LanguageId[],
): LspPool {
  session.onSnapshot((snap) => {
    const paths = followsCheckout(snap)
      ? snap.changed.filter((f) => f.status !== 'D' && !f.binary).map((f) => f.path)
      : [];
    void lsp.track(paths);
  });
  // Progress repeats the full status; print each changed warning or error once.
  const reported = new Map<string, string>();
  const lsp = new LspPool({
    root: repo.root,
    overrides,
    preload,
    read: async (path) => {
      const buf = await session.readSide(await session.snapshotter.current(), path, 'new');
      return buf?.toString('utf8') ?? null;
    },
    has: async (path) => session.hasSide(await session.snapshotter.current(), path, 'new'),
    onStatus: (status) => {
      for (const s of status.servers) {
        const message = s.state === 'unavailable' ? (s.message ?? 'unavailable') : s.notice?.message;
        if (!message) {
          reported.delete(s.command);
          continue;
        }
        if (reported.get(s.command) === message) continue;
        reported.set(s.command, message);
        console.error(`${c.red('✖')} lsp ${s.name}: ${message}`);
      }
      hub.broadcast({ type: 'lsp', payload: status });
    },
  });
  return lsp;
}

program.exitOverride();
program.parseAsync(process.argv).catch((e) => {
  if (e instanceof CommanderError) process.exit(e.exitCode);
  console.error(`${c.red('✖')} ${e instanceof Error ? e.message : e}`);
  process.exit(e instanceof RevspecError || e instanceof GitError || e instanceof GithubError ? 2 : 1);
});
