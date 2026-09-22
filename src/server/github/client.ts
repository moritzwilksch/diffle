import { execFile } from 'node:child_process';
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

/** Said wherever a GitHub feature is asked for without a token. */
export const NO_TOKEN = 'No GitHub token: set GITHUB_TOKEN or sign in with gh auth login';

/**
 * Every GitHub request diffle makes. The test seam: a fake answers queries by shape, nothing
 * else in the server knows about HTTP. Failures surface as `GithubError`, GitHub's own
 * message included.
 */
export interface GithubClient {
  graphql<T>(query: string, variables: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
}

/** Where a token came from, for the startup line. */
export type TokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh auth token';

/**
 * `GITHUB_TOKEN`, then `GH_TOKEN`, then the token `gh` holds. Null when none of them has
 * one: diffle then runs without GitHub, the origin repository still shows and everything
 * else says why it is off.
 */
export async function resolveToken(
  env: NodeJS.ProcessEnv = process.env,
  ghToken: () => Promise<string | null> = ghAuthToken,
): Promise<{ token: string; source: TokenSource } | null> {
  for (const source of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const token = env[source]?.trim();
    if (token) return { token, source };
  }
  const token = await ghToken();
  return token ? { token, source: 'gh auth token' } : null;
}

/** The only `gh` left: its stored token, or null when gh is missing, signed out, or slow. */
export function ghAuthToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const token = stdout?.trim();
      resolve(!err && token ? token : null);
    });
  });
}

export interface ClientOptions {
  /** REST root; the GraphQL endpoint is `/graphql` under it. `GITHUB_API_URL` (as Actions sets it), else github.com. */
  baseUrl?: string;
  /** Replaces the global fetch. Test seam. */
  fetch?: typeof fetch;
}

/** The real client, over `@octokit/core`. */
export function createGithubClient(token: string, { baseUrl, fetch: customFetch }: ClientOptions = {}): GithubClient {
  const octokit = new Octokit({
    auth: token,
    baseUrl: baseUrl || process.env.GITHUB_API_URL || undefined,
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
