#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { formatPrompt } from '../server/comments/format.js';
import { GitError, GitRepo } from '../server/git/GitRepo.js';
import { GithubError } from '../server/github.js';
import { LspBridge } from '../server/lsp/LspBridge.js';
import { RevspecError } from '../server/revspec.js';
import { DEFAULT_PORT, hasClientBuild, Server } from '../server/Server.js';
import { Session } from '../server/Session.js';
import { UserConfigStore } from '../server/UserConfig.js';
import { WsHub } from '../server/ws.js';
import { followsCheckout, isPython, type ModeRequest } from '../shared/protocol.js';
import { parseContext, parsePort } from './args.js';
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
  watch: boolean;
  timing: boolean;
  dev?: boolean;
  autoViewed: string[];
  context?: number;
  /** true: the configured command; string: an explicit one. */
  lsp?: true | string;
}

const program = new Command()
  .name('diffle')
  .description('Review a git diff in the browser and export line comments as an agent prompt.')
  .version(pkg.version, '-v, --version', 'print the version and exit')
  .option('-C <path>', 'run as if started in <path> (any directory inside a git worktree)')
  .option(
    '-p, --port <port>',
    `port to listen on (default: ${DEFAULT_PORT}, or the next free one; 0 = random)`,
    parsePort,
  )
  .option('-H, --host <host>', 'address to bind; use 0.0.0.0 to expose on the network', '127.0.0.1')
  .option('--no-open', 'do not open a browser')
  .option('--no-watch', 'do not watch for changes')
  .addOption(
    new Option('--auto-viewed <glob>', 'mark matching files viewed for this session (repeatable)')
      .argParser(collect)
      .default([], 'none'),
  )
  .option('-U, --context <n>', 'context lines around changes for this session (default: config, 5)', parseContext)
  .option(
    '--lsp [command]',
    'start a language server for go-to-definition, references and symbols (default command: config lspCommand, "pyrefly lsp")',
  )
  .option('--timing', 'print startup phase timings to stderr')
  .option('--dev', 'serve the client through Vite (development)', process.env.DIFFLE_DEV === '1' ? true : undefined)
  .argument('[revs...]', 'git-diff style revisions: <rev> | <a>..<b> | <a>...<b> | <a> <b>')
  .addHelpText(
    'after',
    `
Shorthands (in place of <revs>):
  working                  same as HEAD: uncommitted changes, staged and untracked included
  branch [base]            same as <base>...HEAD: the commits on this branch (base: the default branch)
  pr [number|url]          a GitHub pull request: its base...head, fetched if needed
                           (without an argument: the pull request for this branch)

Revisions follow git diff:
  diffle HEAD~3            the last three commits, plus uncommitted changes
  diffle main..feat        main vs feat
  diffle main...feat       what feat added since it left main

Status goes to stderr, so stdout carries only the review: closing diffle (Ctrl+C)
prints the open comments as a prompt for an agent.`,
  )
  .action(async (revs: string[], _o, cmd: Command) => {
    if (revs.length === 0) cmd.help();
    await run({ kind: 'revspec', args: revs }, cmd.optsWithGlobals<GlobalOpts>());
  });

// Shorthands name what to compare, not commands, so help lists them separately.
program
  .command('working', { hidden: true })
  .summary('same as HEAD')
  .description('Same as `diffle HEAD`: uncommitted changes, staged and untracked files included.')
  .action(async (_o, cmd: Command) => run({ kind: 'working' }, cmd.optsWithGlobals<GlobalOpts>()));

program
  .command('branch', { hidden: true })
  .argument('[base]', 'branch to compare against; default: the default branch')
  .summary('same as <base>...HEAD')
  .description('Same as `diffle <base>...HEAD`: the commits this branch added since it left <base>.')
  .action(async (base: string | undefined, _o, cmd: Command) =>
    run({ kind: 'branch', base }, cmd.optsWithGlobals<GlobalOpts>()),
  );

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
  .description('set the language-server command')
  .argument('<command>', 'shell command that starts a stdio language server, e.g. "pyrefly lsp"')
  .action(async (command: string) => {
    const store = await UserConfigStore.open();
    await store.set({ lspCommand: command });
    console.log(store.get().lspCommand);
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

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
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
  const lsp = opts.lsp
    ? startLsp(typeof opts.lsp === 'string' ? opts.lsp : config.get().lspCommand, repo, session, hub)
    : null;
  const server = new Server(
    { session, config, extraAutoViewed: opts.autoViewed, hub, lsp },
    { port: opts.port ?? DEFAULT_PORT, probe: opts.port == null, host: opts.host, dev: opts.dev || !hasClientBuild() },
  );
  // Every long-lived resource goes through one release, whatever ends the run: a
  // signal, a usage error, or a failure such as an occupied port. Wait for git
  // before deleting its refs or clone; bound socket and LSP shutdown separately.
  const dispose = () =>
    Promise.all([
      session.close(),
      Promise.race([
        Promise.allSettled([server.close(), lsp?.close()]),
        new Promise((res) => setTimeout(res, 1500).unref()),
      ]),
    ]).then(closeRepo);

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

  try {
    // Bind and open the browser before any further git work.
    const url = await server.listen();
    timing.mark('listen');
    if (opts.open) openBrowser(url.href);
    console.error(`🚀 diffle running at ${c.cyan(url.href)}`);
    console.error(`📂 ${c.dim('repo')} ${repo.root}`);

    const snap = await session.start(req);
    timing.mark('snapshot');
    const n = snap.changed.length;
    const adds = snap.changed.reduce((a, f) => a + f.additions, 0);
    const dels = snap.changed.reduce((a, f) => a + f.deletions, 0);
    console.error(`🔍 ${c.dim('comparing')} ${c.bold(snap.mode.label)}`);
    if (n === 0) console.error(`${c.yellow('!')} No differences. Open any file from the tree to comment on it.`);
    else console.error(`📝 ${n} changed file${n === 1 ? '' : 's'}  ${c.green(`+${adds}`)} ${c.red(`−${dels}`)}`);
    if (snap.mode.live !== 'none')
      console.error(
        `👀 ${c.dim(snap.mode.live === 'worktree' ? 'watching the worktree' : 'watching refs')}${opts.watch ? '' : c.dim(' (disabled with --no-watch)')}`,
      );
    if (lsp)
      console.error(
        `🧭 ${c.dim('lsp')} ${lsp.status().command}${followsCheckout(snap) ? '' : c.dim(' (symbol navigation needs the new side to be the checkout)')}`,
      );
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
 * The bridge reads new-side text through the session, so the snapshot allowlist
 * applies to every LSP path. Every snapshot re-opens the diff's Python files in
 * the server, so references in them are found from the reviewed text (see
 * LspBridge.track). Nothing is opened when the new side is not the checkout:
 * the client refuses symbol navigation there, and the server would otherwise see
 * text that contradicts the disk it indexes.
 */
function startLsp(command: string, repo: GitRepo, session: Session, hub: WsHub): LspBridge {
  session.onSnapshot((snap) => {
    const paths = followsCheckout(snap)
      ? snap.changed.filter((f) => f.status !== 'D' && !f.binary && isPython(f.path)).map((f) => f.path)
      : [];
    void lsp.track(paths);
  });
  const lsp = LspBridge.start({
    command,
    root: repo.root,
    read: async (path) => {
      const buf = await session.readSide(await session.snapshotter.current(), path, 'new');
      return buf?.toString('utf8') ?? null;
    },
    has: async (path) => session.hasSide(await session.snapshotter.current(), path, 'new'),
    onStatus: (status) => {
      if (status.state === 'unavailable') console.error(`${c.red('✖')} lsp unavailable: ${status.message}`);
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
