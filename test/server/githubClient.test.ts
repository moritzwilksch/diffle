import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createGithubClient, GithubError, noToken, resolveToken, useEnvProxy } from '@/server/github/client.js';

describe('resolveToken', () => {
  it('prefers GITHUB_TOKEN, then GH_TOKEN, then what gh holds for github.com', async () => {
    const asked: string[] = [];
    const gh = async (host: string) => (asked.push(host), 'from-gh');
    expect(await resolveToken('github.com', { GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, gh)).toEqual({
      token: 'a',
      source: 'GITHUB_TOKEN',
    });
    expect(await resolveToken('github.com', { GITHUB_TOKEN: ' ', GH_TOKEN: ' b ' }, gh)).toEqual({
      token: 'b',
      source: 'GH_TOKEN',
    });
    expect(await resolveToken('github.com', {}, gh)).toEqual({ token: 'from-gh', source: 'gh auth token' });
    expect(asked).toEqual(['github.com']);
  });

  it('reads the enterprise variables for a GitHub Enterprise Server, as gh does', async () => {
    const env = { GITHUB_TOKEN: 'cloud', GH_ENTERPRISE_TOKEN: 'server' };
    expect(await resolveToken('github.work.com', env, async () => null)).toEqual({
      token: 'server',
      source: 'GH_ENTERPRISE_TOKEN',
    });
    expect(await resolveToken('acme.ghe.com', env, async () => null)).toEqual({
      token: 'cloud',
      source: 'GITHUB_TOKEN',
    });
    const asked: string[] = [];
    await resolveToken('github.work.com', { GITHUB_TOKEN: 'cloud' }, async (host) => (asked.push(host), null));
    expect(asked).toEqual(['github.work.com']);
  });

  it('is null when nothing has a token', async () => {
    expect(await resolveToken('github.com', {}, async () => null)).toBeNull();
  });

  it('says where to put a token for the host that lacks one', () => {
    expect(noToken('github.com')).toBe(
      'No GitHub token for github.com: set GITHUB_TOKEN or sign in with gh auth login',
    );
    expect(noToken('github.work.com')).toBe(
      'No GitHub token for github.work.com: set GITHUB_ENTERPRISE_TOKEN or sign in with gh auth login --hostname github.work.com',
    );
  });
});

describe('createGithubClient', () => {
  /** A GitHub that answers every GraphQL request with `status` and `body`, recording the request. */
  function server(status: number, body: unknown) {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      seen.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    return { seen, fetch: fetch as typeof globalThis.fetch };
  }

  it('posts the document and variables with the token to the GraphQL endpoint of the base url', async () => {
    const api = server(200, { data: { viewer: { login: 'me' } } });
    const client = createGithubClient('tok', { baseUrl: 'https://ghe.example.com/api/v3', fetch: api.fetch });
    const data = await client.graphql<{ viewer: { login: string } }>('query{viewer{login}}', { n: 1 });
    expect(data).toEqual({ viewer: { login: 'me' } });
    expect(api.seen).toHaveLength(1);
    // Octokit knows GitHub Enterprise Server keeps GraphQL beside, not under, the REST root.
    expect(api.seen[0]!.url).toBe('https://ghe.example.com/api/graphql');
    expect(api.seen[0]!.headers.authorization).toBe('token tok');
    expect(api.seen[0]!.headers['user-agent']).toMatch(/^diffle\//);
    expect(api.seen[0]!.body).toEqual({ query: 'query{viewer{login}}', variables: { n: 1 } });
  });

  it('turns a missing pull request into a 409 with GitHub’s own message', async () => {
    const api = server(200, {
      data: { repository: { pullRequest: null } },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of 999.' }],
    });
    const client = createGithubClient('tok', { fetch: api.fetch });
    await expect(client.graphql('query{x}', {})).rejects.toMatchObject({
      status: 409,
      message: 'GitHub: Could not resolve to a PullRequest with the number of 999.',
    });
  });

  it('turns a rejected token into a 409 that says so', async () => {
    const api = server(401, { message: 'Bad credentials' });
    const client = createGithubClient('tok', { fetch: api.fetch });
    await expect(client.graphql('query{x}', {})).rejects.toMatchObject({
      status: 409,
      message: /rejected the token \(401\): Bad credentials/,
    });
  });

  it('turns any other GraphQL error and a failing server into 502', async () => {
    const refused = server(200, { errors: [{ type: 'UNPROCESSABLE', message: 'Line could not be resolved' }] });
    await expect(createGithubClient('tok', { fetch: refused.fetch }).graphql('mutation{x}', {})).rejects.toMatchObject({
      status: 502,
      message: 'GitHub: Line could not be resolved',
    });
    const down = server(503, { message: 'unavailable' });
    await expect(createGithubClient('tok', { fetch: down.fetch }).graphql('query{x}', {})).rejects.toMatchObject({
      status: 502,
      message: /GitHub 503/,
    });
    const offline = createGithubClient('tok', {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(offline.graphql('query{x}', {})).rejects.toMatchObject({
      status: 502,
      message: 'cannot reach GitHub: fetch failed',
    });
  });

  it('gives up on a slow GitHub after the timeout', async () => {
    const slow = createGithubClient('tok', {
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });
    const err = await slow.graphql('query{x}', {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err).toMatchObject({ status: 502, message: 'GitHub did not answer within 20ms' });
  });
});

describe('useEnvProxy', () => {
  it('sends GitHub requests through the proxy the environment names', async () => {
    const seen: string[] = [];
    const proxy = createServer((req, res) => (seen.push(`${req.method} ${req.url}`), res.writeHead(502).end()));
    // Node versions differ on plain HTTP: some forward absolute-form requests, others tunnel.
    proxy.on(
      'connect',
      (req, socket) => (seen.push(`CONNECT ${req.url}`), socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')),
    );
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const restore = useEnvProxy({ HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` });
    try {
      const client = createGithubClient('t', { baseUrl: 'http://github.invalid/api/v3' });
      await expect(client.graphql('{ viewer { login } }', {})).rejects.toBeInstanceOf(GithubError);
      expect(seen).toEqual([
        expect.stringMatching(/^(POST http:\/\/github\.invalid\/api\/graphql|CONNECT github\.invalid:80)$/),
      ]);
    } finally {
      restore();
      proxy.close();
    }
  });

  it('turns a malformed proxy URL into a GithubError', () => {
    expect(() => useEnvProxy({ HTTPS_PROXY: 'not a url' })).toThrow(GithubError);
  });
});
