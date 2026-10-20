import { execFile } from 'node:child_process';
import { setGlobalProxyFromEnv } from 'node:http';
import { Octokit } from '@octokit/core';
import pkg from '../../../package.json' with { type: 'json' };

/** A precondition the user can fix (no token, no PR, wrong mode, unpushed head): the route answers 4xx. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 502 = 409,
  ) {
    super(message);
  }
}

/** Said wherever a GitHub feature is asked for without a token for `host`. */
export function noToken(host: string): string {
  const login = host === 'github.com' ? 'gh auth login' : `gh auth login --hostname ${host}`;
  return `No GitHub token for ${host}: set ${tokenVariables(host)[0]} or sign in with ${login}`;
}

/**
 * Every GitHub request diffle makes. The test seam: a fake answers queries by shape, nothing
 * else in the server knows about HTTP. Failures surface as `GithubError`, GitHub's own
 * message included.
 */
export interface GithubClient {
  graphql<T>(query: string, variables: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
}

/** Where a token came from, for the startup line. */
export type TokenSource = (typeof TOKEN_VARIABLES)[keyof typeof TOKEN_VARIABLES][number] | 'gh auth token';

/** gh's own split: GitHub Enterprise Server tokens live apart from github.com and GHE.com ones. */
const TOKEN_VARIABLES = {
  cloud: ['GITHUB_TOKEN', 'GH_TOKEN'],
  server: ['GITHUB_ENTERPRISE_TOKEN', 'GH_ENTERPRISE_TOKEN'],
} as const;

/** The environment variables holding a token for `host`, in the order diffle reads them. */
export function tokenVariables(host: string): readonly TokenSource[] {
  return host === 'github.com' || host.endsWith('.ghe.com') ? TOKEN_VARIABLES.cloud : TOKEN_VARIABLES.server;
}

/**
 * The token for `host`: its environment variables (see `tokenVariables`), then the one `gh`
 * holds for it. Null when none has one: diffle then runs without GitHub, the origin
 * repository still shows and everything else says why it is off.
 */
export async function resolveToken(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
  ghToken: (host: string) => Promise<string | null> = ghAuthToken,
): Promise<{ token: string; source: TokenSource } | null> {
  for (const source of tokenVariables(host)) {
    const token = env[source]?.trim();
    if (token) return { token, source };
  }
  const token = await ghToken(host);
  return token ? { token, source: 'gh auth token' } : null;
}

/** The only `gh` left: its stored token for `host`, or null when gh is missing, signed out, or slow. */
export function ghAuthToken(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token', '--hostname', host], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const token = stdout?.trim();
      resolve(!err && token ? token : null);
    });
  });
}

/**
 * Routes Node's global `fetch`, and with it Octokit, through the proxy that `HTTPS_PROXY`,
 * `HTTP_PROXY` and `NO_PROXY` (either case) name, as git already does. A malformed proxy
 * URL is a `GithubError`. Returns what undoes it.
 */
export function useEnvProxy(env: NodeJS.ProcessEnv = process.env): () => void {
  try {
    return setGlobalProxyFromEnv(env);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_PROXY_INVALID_CONFIG') throw e;
    throw new GithubError(`invalid proxy environment: ${(e as Error).message}`, 400);
  }
}

export interface ClientOptions {
  /** REST root (see `apiBaseUrl`); Octokit derives the GraphQL endpoint from it. Default github.com. */
  baseUrl?: string;
  /** Replaces the global fetch. Test seam. */
  fetch?: typeof fetch;
}

/** The real client, over `@octokit/core`. */
export function createGithubClient(token: string, { baseUrl, fetch: customFetch }: ClientOptions = {}): GithubClient {
  const octokit = new Octokit({
    auth: token,
    baseUrl,
    userAgent: `diffle/${pkg.version}`,
    request: customFetch ? { fetch: customFetch } : {},
  });
  return {
    async graphql<T>(query: string, variables: Record<string, unknown>, opts: { timeoutMs?: number } = {}) {
      const request = opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : undefined;
      try {
        return (await octokit.graphql(query, { ...variables, request })) as T;
      } catch (e) {
        throw toGithubError(e, opts.timeoutMs);
      }
    },
  };
}

/** What Octokit throws, read without depending on its error packages. */
interface GraphqlFailure {
  name: string;
  message: string;
  status?: number;
  /** Absent on an `HttpError` when no response came back: the fetch itself failed. */
  response?: unknown;
  cause?: unknown;
  errors?: { type?: string; message?: string }[];
}

/**
 * GitHub's answer, as a `GithubError`. Something the user can fix (a rejected token, a missing
 * pull request) is 409; GitHub refusing the content (422) or not answering at all is 502.
 */
function toGithubError(e: unknown, timeoutMs?: number): GithubError {
  if (e instanceof GithubError) return e;
  const err = e as Partial<GraphqlFailure>;
  if (err?.name === 'GraphqlResponseError' && Array.isArray(err.errors) && err.errors.length) {
    const detail = err.errors.map((x) => x.message ?? 'unknown error').join('; ');
    const fixable = err.errors.every((x) => x.type === 'NOT_FOUND' || x.type === 'FORBIDDEN');
    return new GithubError(`GitHub: ${detail}`, fixable ? 409 : 502);
  }
  if (err?.name === 'HttpError' && typeof err.status === 'number') {
    const detail = firstLine(err.message);
    if (err.response === undefined) {
      // Octokit reports a failed fetch as a 500 with the failure as `cause`; nothing came from GitHub.
      const cause = (err.cause as { name?: string } | undefined)?.name;
      if (cause === 'TimeoutError' || cause === 'AbortError')
        return new GithubError(`GitHub did not answer within ${timeoutMs ?? '?'}ms`, 502);
      return new GithubError(`cannot reach GitHub: ${detail}`, 502);
    }
    if (err.status === 401) return new GithubError(`GitHub rejected the token (401): ${detail}`, 409);
    if (err.status === 403 || err.status === 404) return new GithubError(`GitHub ${err.status}: ${detail}`, 409);
    return new GithubError(`GitHub ${err.status}: ${detail}`, 502);
  }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError')
    return new GithubError(`GitHub did not answer within ${timeoutMs ?? '?'}ms`, 502);
  const detail = e instanceof Error ? firstLine(e.message) : String(e);
  return new GithubError(`cannot reach GitHub: ${detail}`, 502);
}

function firstLine(s: string | undefined): string {
  return (s ?? '').trim().split('\n')[0] ?? '';
}
