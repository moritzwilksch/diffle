import { Command, InvalidArgumentError } from 'commander';
import { readFile } from 'node:fs/promises';
import { ImportError, parseImports } from '../server/comments/import.js';
import { GitRepo } from '../server/git/GitRepo.js';
import { RunFile } from '../server/RunFile.js';
import type { CommentThread, ThreadCreate, ThreadState } from '../shared/protocol.js';
import { parsePort } from './args.js';

interface CommentOpts {
  C?: string;
  url?: string;
  port?: number;
  as?: string;
}

/** A running server could not be reached, or an id was unknown. Exit 1. */
export class CommentCliError extends Error {}

/**
 * Reads a `--comment` / `diffle comment add` payload: `@file` reads a file, `-`
 * or `@-` (the curl spelling) reads stdin, anything else is the JSON itself.
 */
async function readPayload(value: string): Promise<string> {
  if (value === '-' || value === '@-') return readStdin();
  if (value.startsWith('@')) {
    try {
      return await readFile(value.slice(1), 'utf8');
    } catch (e) {
      throw new ImportError(`cannot read ${value.slice(1)}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  return value;
}

/** Reads all of stdin as UTF-8. */
export function readStdin(): Promise<string> {
  return new Promise((res, rej) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => (data += d));
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', rej);
  });
}

/** Parses payloads into imports; `as` labels them as agent-authored unless the payload says otherwise. */
export async function loadImports(values: string[], as?: string): Promise<ThreadCreate[]> {
  const out: ThreadCreate[] = [];
  for (const v of values) {
    for (const t of parseImports(await readPayload(v))) {
      out.push({ ...t, author: t.author ?? 'agent', authorName: t.authorName ?? as });
    }
  }
  return out;
}

/** The server to talk to: `--url`, then `--port` on loopback, then this repository's run file. */
async function serverUrl(opts: CommentOpts): Promise<string> {
  if (opts.url) {
    try {
      return new URL(opts.url).href;
    } catch {
      throw new CommentCliError(`invalid --url: ${opts.url}`);
    }
  }
  if (opts.port != null) return `http://127.0.0.1:${opts.port}/`;
  let repo: GitRepo;
  try {
    repo = await GitRepo.open(opts.C ?? process.cwd());
  } catch {
    throw new CommentCliError(`not a git repository: ${opts.C ?? process.cwd()}`);
  }
  const info = await new RunFile(repo.gitDir).read();
  if (!info) throw new CommentCliError('no diffle server for this repository (start one with `diffle <mode>`, or pass --port)');
  return info.url;
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  let res: Response;
  try {
    res = await fetch(new URL(path, base), { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch (e) {
    throw new CommentCliError(`cannot reach the diffle server at ${base}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = text;
  if (res.headers.get('content-type')?.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the text */
    }
  }
  return { status: res.status, body: body as T };
}

function errorOf(body: unknown, status: number): string {
  return (typeof body === 'object' && body != null && typeof (body as { error?: unknown }).error === 'string' && (body as { error: string }).error) || `HTTP ${status}`;
}

export const parseState = (raw: string): ThreadState => {
  if (raw !== 'open' && raw !== 'resolved' && raw !== 'all') throw new InvalidArgumentError('expected open, resolved or all');
  return raw;
};
export const parseFormat = (raw: string): 'prompt' | 'json' => {
  if (raw !== 'prompt' && raw !== 'json') throw new InvalidArgumentError('expected prompt or json');
  return raw;
};

const out = (v: unknown) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v) + '\n');

/** `diffle comment add|get|resolve`. Talks to a running server over HTTP only. */
export function commentCommand(): Command {
  const cmd = new Command('comment')
    .description('talk to the running review: seed findings, read the open threads, resolve them')
    .option('--url <url>', 'server address, e.g. the one the human is looking at; default: the run file in <git-dir>/diffle/server.json')
    .option('--port <port>', 'server port on 127.0.0.1; default: the run file', parsePort);

  cmd
    .command('add')
    .description('post threads; prints {"added","skipped","threadIds"}')
    .argument('[payload]', 'one comment object or an array as JSON; @file reads a file, - or @- (default) reads stdin')
    .option('--as <name>', 'author label for the threads (they are agent-authored)')
    .action(async (payload: string | undefined, _o, c: Command) => {
      const opts = c.optsWithGlobals<CommentOpts>();
      const imports = await loadImports([payload ?? '-'], opts.as);
      const base = await serverUrl(opts);
      const res = await call<CommentThread[]>(base, '/api/threads', { method: 'POST', body: JSON.stringify(imports) });
      if (res.status !== 201) throw new CommentCliError(errorOf(res.body, res.status));
      out({ added: res.body.length, skipped: imports.length - res.body.length, threadIds: res.body.map((t) => t.id) });
    });

  cmd
    .command('get')
    .description('print the threads: the agent prompt (default), or JSON')
    .option('--state <state>', 'open (default), resolved, or all', parseState, 'open')
    .option('--format <format>', 'prompt (default) or json', parseFormat, 'prompt')
    .option('--path <path>', 'only threads on this file')
    .action(async (_o, c: Command) => {
      const opts = c.optsWithGlobals<CommentOpts & { state: ThreadState; format: 'prompt' | 'json'; path?: string }>();
      const base = await serverUrl(opts);
      const q = new URLSearchParams({ state: opts.state });
      if (opts.path) q.set('path', opts.path);
      const res = await call<unknown>(base, `${opts.format === 'prompt' ? '/api/threads/export' : '/api/threads'}?${q}`);
      if (res.status !== 200) throw new CommentCliError(errorOf(res.body, res.status));
      out(opts.format === 'prompt' ? (res.body as string) : JSON.stringify(res.body, null, 2) + '\n');
    });

  cmd
    .command('reply')
    .description('answer a thread; prints the updated thread as JSON')
    .argument('<threadId>')
    .argument('<body>', 'message text; - or @- reads stdin')
    .option('--as <name>', 'author label (the reply is agent-authored)')
    .action(async (id: string, body: string, _o, c: Command) => {
      const opts = c.optsWithGlobals<CommentOpts>();
      const text = body === '-' || body === '@-' ? await readPayload('-') : body;
      if (!text.trim()) throw new ImportError('reply body is empty');
      const base = await serverUrl(opts);
      const res = await call<unknown>(base, `/api/threads/${encodeURIComponent(id)}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: text, author: 'agent', authorName: opts.as }),
      });
      if (res.status === 404) throw new CommentCliError(`unknown thread: ${id}`);
      if (res.status !== 201) throw new CommentCliError(errorOf(res.body, res.status));
      out(JSON.stringify(res.body, null, 2) + '\n');
    });

  cmd
    .command('resolve')
    .description('mark threads resolved; prints {"resolved","notFound"} and exits 1 if any id is unknown')
    .argument('<threadId...>')
    .action(async (ids: string[], _o, c: Command) => {
      const opts = c.optsWithGlobals<CommentOpts>();
      const base = await serverUrl(opts);
      const resolved: string[] = [];
      const notFound: string[] = [];
      for (const id of ids) {
        const res = await call<unknown>(base, `/api/threads/${encodeURIComponent(id)}/resolved`, { method: 'PUT', body: JSON.stringify({ resolved: true }) });
        if (res.status === 200) resolved.push(id);
        else if (res.status === 404) notFound.push(id);
        else throw new CommentCliError(errorOf(res.body, res.status));
      }
      out({ resolved, notFound });
      if (notFound.length) process.exitCode = 1;
    });

  return cmd;
}
