#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { CommentStore, UnquotableError } from '../server/comments/CommentStore.js';
import { formatPrompt } from '../server/comments/format.js';
import { ImportError } from '../server/comments/import.js';
import { GitError, GitRepo } from '../server/git/GitRepo.js';
import { LspBridge } from '../server/lsp/LspBridge.js';
import { resolveMode } from '../server/mode.js';
import { RevspecError } from '../server/revspec.js';
import { RunFile } from '../server/RunFile.js';
import { DEFAULT_PORT, hasClientBuild, Server } from '../server/Server.js';
import { Session } from '../server/Session.js';
import { UserConfigStore } from '../server/UserConfig.js';
import { WsHub } from '../server/ws.js';
import { followsCheckout, isPython, type ModeRequest, type ThreadState } from '../shared/protocol.js';
import { parseContext, parsePort } from './args.js';
import { commentCommand, loadImports, parseFormat, parseState, readStdin } from './comment.js';
import { SKILL } from './skill.js';
import { openBrowser } from './open.js';
import { Timing } from './timing.js';

/** Minimal ANSI colors; off when stderr is not a TTY or NO_COLOR is set. */
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const c = { red: paint('31'), green: paint('32'), yellow: paint('33'), cyan: paint('36'), bold: paint('1'), dim: paint('2') };

interface GlobalOpts {
  C?: string;
  /** Unset: DEFAULT_PORT, or the next free one. */
  port?: number;
  host: string;
  open: boolean;
  watch: boolean;
  timing: boolean;
  dev: boolean;
  autoViewed: string[];
  context?: number;
  /** true: the configured command; string: an explicit one. */
  lsp?: true | string;
  /** `--comment` payloads: JSON, @file, or - for stdin. */
  comment: string[];
  /** Author label for imported threads. */
  as?: string;
  /** Detach after startup and print the handshake on stdout. */
  background: boolean;
}

/** Set on the re-executed child of `--background`. */
const IS_BACKGROUND_CHILD = process.env.DIFFLE_BACKGROUND === '1';

const program = new Command()
  .name('diffle')
  .description('Review a git diff in the browser and export line comments as an agent prompt.')
  .version(pkg.version, '-v, --version', 'print the version and exit')
  .option('-C <path>', 'run as if started in <path> (any directory inside a git worktree)')
  .option('-p, --port <port>', `port to listen on (default: ${DEFAULT_PORT}, or the next free one; 0 = random)`, parsePort)
  .option('-H, --host <host>', 'address to bind; use 0.0.0.0 to expose on the network', '127.0.0.1')
  .option('--no-open', 'do not open a browser')
  .option('--no-watch', 'do not watch for changes')
  .option('--auto-viewed <glob>', 'mark matching files viewed for this session (repeatable)', collect, [])
  .option('-U, --context <n>', 'context lines around changes for this session (default: config, 5)', parseContext)
  .option('--lsp [command]', 'start a language server for go-to-definition, references and symbols (default command: config lspCommand, "pyrefly lsp")')
  .option('--comment <json|@file|->', 'seed threads from a JSON payload (one object or an array; repeatable; - or @- reads stdin)', collect, [])
  .option('--as <name>', 'author label for --comment threads, e.g. "claude"')
  .option('--background', 'detach after startup and print {"port","url","pid"} on stdout; implies --no-open')
  .option('--skill', 'print the agent-facing usage guide on stdout and exit')
  .option('--timing', 'print startup phase timings to stderr')
  .option('--dev', 'serve the client through Vite (development)', process.env.DIFFLE_DEV === '1')
  .argument('[revs...]', 'git-diff style revisions: <rev> | <a>..<b> | <a>...<b> | <a> <b>')
  .addHelpText(
    'after',
    `
Revisions follow git diff:
  diffle HEAD~3            HEAD~3 vs worktree
  diffle main..feat        main vs feat
  diffle main...feat       merge-base(main, feat) vs feat

Named modes are shorthand:
  working                  same as: diffle HEAD
  branch [base]            same as: diffle <base>...HEAD
  pr                       same as: diffle <default-branch>...HEAD

Agent loop: status goes to stderr, so stdout carries only payloads.
  diffle working --comment @findings.json --as claude   seed findings, review, Ctrl+C prints the open threads
  diffle working --background                          detach; then diffle comment add | get | resolve`,
  )
  .action(async (revs: string[], opts: { skill?: boolean }, cmd: Command) => {
    if (opts.skill) {
      process.stdout.write(SKILL);
      return;
    }
    if (revs.length === 0) cmd.help();
    await run({ kind: 'revspec', args: revs }, cmd.optsWithGlobals<GlobalOpts>());
  });

program
  .command('working')
  .description('review uncommitted changes: HEAD vs worktree, incl. staged and untracked (same as: diffle HEAD)')
  .action(async (_o, cmd: Command) => run({ kind: 'working' }, cmd.optsWithGlobals<GlobalOpts>()));

program
  .command('branch')
  .argument('[base]', 'base branch; default: the default branch')
  .description('review commits on this branch: merge-base(base, HEAD) vs HEAD (same as: diffle <base>...HEAD)')
  .action(async (base: string | undefined, _o, cmd: Command) =>
    run({ kind: 'branch', base }, cmd.optsWithGlobals<GlobalOpts>()),
  );

program
  .command('pr')
  .description('review committed changes on this branch, like a GitHub PR (same as: diffle origin/main...HEAD)')
  .action(async (_o, cmd: Command) => run({ kind: 'pr' }, cmd.optsWithGlobals<GlobalOpts>()));

program
  .command('export')
  .description('print stored threads without a server: the agent prompt, or JSON (same mode syntax as review)')
  .argument('[mode...]', 'working | branch [base] | pr | <revspec>; default: working')
  .option('--state <state>', 'open (default), resolved, or all', parseState, 'open')
  .option('--format <format>', 'prompt (default) or json', parseFormat, 'prompt')
  .action(async (mode: string[], o: { state: ThreadState; format: 'prompt' | 'json' }, cmd: Command) => {
    const opts = cmd.optsWithGlobals<GlobalOpts>();
    const repo = await openRepo(opts);
    const spec = await resolveMode(modeRequestFromArgs(mode.length ? mode : ['working']), repo);
    const store = await CommentStore.open(repo.gitDir, spec.commentKey);
    const threads = store.threads({ state: o.state });
    process.stdout.write(o.format === 'json' ? JSON.stringify(threads, null, 2) + '\n' : formatPrompt(threads));
  });

program.addCommand(commentCommand());

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
  .argument('<glob...>', 'patterns for files that start viewed and collapsed, e.g. "*.lock"')
  .action(async (globs: string[]) => {
    const store = await UserConfigStore.open();
    await store.set({ autoViewed: [...new Set([...store.get().autoViewed, ...globs])] });
    console.log(store.get().autoViewed.join('\n'));
  });
config
  .command('set-context')
  .argument('<n>', 'context lines around changes', parseContext)
  .action(async (n: number) => {
    const store = await UserConfigStore.open();
    await store.set({ contextLines: n });
    console.log(store.get().contextLines);
  });
config
  .command('set-lsp')
  .argument('<command>', 'shell command that starts a stdio language server, e.g. "pyrefly lsp"')
  .action(async (command: string) => {
    const store = await UserConfigStore.open();
    await store.set({ lspCommand: command });
    console.log(store.get().lspCommand);
  });
config
  .command('remove-auto-viewed')
  .argument('<glob...>')
  .action(async (globs: string[]) => {
    const store = await UserConfigStore.open();
    await store.set({ autoViewed: store.get().autoViewed.filter((g) => !globs.includes(g)) });
    console.log(store.get().autoViewed.join('\n'));
  });

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function modeRequestFromArgs(args: string[]): ModeRequest {
  const [first, ...rest] = args;
  if (first === 'working') return { kind: 'working' };
  if (first === 'pr') return { kind: 'pr' };
  if (first === 'branch') return { kind: 'branch', base: rest[0] };
  return { kind: 'revspec', args };
}

async function openRepo(opts: GlobalOpts): Promise<GitRepo> {
  const dir = opts.C ?? process.cwd();
  try {
    return await GitRepo.open(dir);
  } catch (e) {
    // git's own exit code for "not a repository"; anything else (git missing, unreadable) is named as such.
    const notRepo = e instanceof GitError && e.code === 128;
    console.error(`${c.red('✖')} ${notRepo ? `not a git repository: ${dir}` : `cannot run git in ${dir}: ${(e as Error).message}`}`);
    process.exit(notRepo ? 128 : 1);
  }
}

async function run(req: ModeRequest, opts: GlobalOpts): Promise<void> {
  const timing = new Timing(opts.timing);
  const repo = await openRepo(opts);
  timing.mark('git rev-parse');
  if (opts.background && !IS_BACKGROUND_CHILD) return runInBackground(repo);

  const hub = new WsHub();
  const config = await UserConfigStore.open();
  const session = new Session(repo, hub, { watch: opts.watch, context: opts.context ?? config.get().contextLines });
  const lsp = opts.lsp ? startLsp(typeof opts.lsp === 'string' ? opts.lsp : config.get().lspCommand, repo, session, hub) : null;
  const server = new Server(
    { session, config, extraAutoViewed: opts.autoViewed, hub, lsp },
    { port: opts.port ?? DEFAULT_PORT, probe: opts.port == null, host: opts.host, dev: opts.dev || !hasClientBuild() },
  );
  const runFile = new RunFile(repo.gitDir);

  // Every long-lived resource goes through one release, whatever ends the run: a
  // signal, a usage error, or a failure such as an occupied port. The LSP child
  // leads its own process group and would otherwise outlive the CLI. Bounded so
  // an open keep-alive or WebSocket connection never hangs the exit; LspBridge.close
  // fits inside the budget.
  const dispose = () =>
    Promise.race([
      Promise.allSettled([runFile.removeIfOwn(), session.close(), server.close(), lsp?.close()]),
      new Promise((res) => setTimeout(res, 1500).unref()),
    ]);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.error(`\n👋 ${c.dim('shutting down')}`);
    // The handoff: the open threads, as a prompt, on stdout. Nothing else in this
    // path may write there. A detached server has no reader.
    if (!IS_BACKGROUND_CHILD) {
      try {
        process.stdout.write(formatPrompt(session.comments.threads({ state: 'open' })));
      } catch {
        /* the session never became ready */
      }
    }
    void dispose().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Bind and open the browser before any further git work.
    const url = await server.listen();
    timing.mark('listen');
    if (opts.open && !IS_BACKGROUND_CHILD) openBrowser(url.href);
    console.error(`🚀 diffle running at ${c.cyan(url.href)}`);
    console.error(`📂 ${c.dim('repo')} ${repo.root}`);

    const snap = await session.start(req);
    timing.mark('snapshot');
    await runFile.write({ port: Number(url.port), url: url.href, pid: process.pid, root: repo.root, commentKey: snap.mode.commentKey, startedAt: Date.now() });
    const n = snap.changed.length;
    const adds = snap.changed.reduce((a, f) => a + f.additions, 0);
    const dels = snap.changed.reduce((a, f) => a + f.deletions, 0);
    console.error(`🔍 ${c.dim('comparing')} ${c.bold(snap.mode.label)}`);
    if (n === 0) console.error(`${c.yellow('!')} No differences. Open any file from the tree to comment on it.`);
    else console.error(`📝 ${n} changed file${n === 1 ? '' : 's'}  ${c.green(`+${adds}`)} ${c.red(`−${dels}`)}`);
    if (snap.mode.live !== 'none') console.error(`👀 ${c.dim(snap.mode.live === 'worktree' ? 'watching the worktree' : 'watching refs')}${opts.watch ? '' : c.dim(' (disabled with --no-watch)')}`);
    if (lsp) console.error(`🧭 ${c.dim('lsp')} ${lsp.status().command}${followsCheckout(snap) ? '' : c.dim(' (symbol navigation needs the new side to be the checkout)')}`);
    if (opts.comment.length) {
      const spool = process.env[COMMENT_SPOOL_ENV];
      const imports = await loadImports(opts.comment, opts.as).finally(() => (spool ? rm(spool, { force: true }) : undefined));
      const { added, skipped } = await session.comments.importThreads(imports, session.quoter());
      if (added.length) hub.broadcast({ type: 'threads' });
      console.error(`💬 ${added.length} agent comment${added.length === 1 ? '' : 's'}${skipped ? c.dim(` (${skipped} duplicate${skipped === 1 ? '' : 's'} skipped)`) : ''}`);
    }
    timing.report();
    if (IS_BACKGROUND_CHILD) {
      // The handshake the parent is waiting for; the pipe closes with the parent.
      process.stdout.write(JSON.stringify({ port: Number(url.port), url: url.href, pid: process.pid }) + '\n');
      process.stdout.on('error', () => {});
    }
  } catch (e) {
    await dispose();
    if (e instanceof RevspecError || e instanceof GitError || e instanceof ImportError || e instanceof UnquotableError) {
      console.error(`${c.red('✖')} ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

/** Path of the stdin payload the parent spooled for a background child; the child deletes it once read. */
const COMMENT_SPOOL_ENV = 'DIFFLE_COMMENT_SPOOL';

/**
 * The detached child gets no stdin, so `--comment -` is read here and forwarded
 * as `@<file>` under `<git-dir>/diffle`: inline argv hits E2BIG past ~128 KiB.
 * Every stdin token gets the same file; the import dedups repeats. Returns the
 * spool path so the parent can remove it if the child dies before reading it.
 */
async function spoolStdinComments(argv: string[], dir: string): Promise<{ argv: string[]; spool?: string }> {
  const isStdin = (v: string) => v === '-' || v === '@-';
  const refersToStdin = (a: string, i: number) => (argv[i - 1] === '--comment' && isStdin(a)) || a === '--comment=-' || a === '--comment=@-';
  if (!argv.some(refersToStdin)) return { argv };
  const spool = join(dir, `comment-${process.pid}.json`);
  await writeFile(spool, await readStdin(), { mode: 0o600 });
  return { argv: argv.map((a, i) => (refersToStdin(a, i) ? (a.startsWith('--comment=') ? `--comment=@${spool}` : `@${spool}`) : a)), spool };
}

/**
 * `--background`: re-exec this command detached, with stderr in
 * `<git-dir>/diffle/server.log`, and relay the child's one-line handshake to
 * stdout. Exits with the child's code if it dies first.
 */
async function runInBackground(repo: GitRepo): Promise<void> {
  const logDir = join(repo.gitDir, 'diffle');
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const log = join(logDir, 'server.log');
  const fd = openSync(log, 'a', 0o600);
  const { argv, spool } = await spoolStdinComments(process.argv.slice(1), logDir);
  const child = spawn(process.execPath, [...process.execArgv, ...argv], {
    detached: true,
    stdio: ['ignore', 'pipe', fd],
    env: { ...process.env, DIFFLE_BACKGROUND: '1', ...(spool ? { [COMMENT_SPOOL_ENV]: spool } : {}) },
  });
  let buf = '';
  const handshake = new Promise<string>((res, rej) => {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) res(buf.slice(0, nl + 1));
    });
    child.on('exit', (code, signal) => rej(new Error(`server exited (${signal ?? code}) before it was ready; see ${log}`)));
    child.on('error', rej);
  });
  try {
    const line = await handshake;
    process.stdout.write(line);
    console.error(`🛰  ${c.dim('running in the background; stop it with')} kill ${child.pid}`);
    child.stdout!.destroy();
    child.unref();
  } catch (e) {
    console.error(`${c.red('✖')} ${(e as Error).message}`);
    if (spool) await rm(spool, { force: true });
    process.exit(child.exitCode ?? 1);
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
    const paths = followsCheckout(snap) ? snap.changed.filter((f) => f.status !== 'D' && !f.binary && isPython(f.path)).map((f) => f.path) : [];
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
  // Malformed comment payloads are usage errors, like a bad revspec.
  process.exit(e instanceof ImportError ? 2 : 1);
});
