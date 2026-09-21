import type { GithubPullRequest } from '../../shared/protocol.js';
import type { GitRepo } from '../git/GitRepo.js';
import { type GithubClient, GithubError } from './client.js';

/** GitHub.com identity from a configured HTTPS, SSH, or scp-style remote URL. */
export function githubRepository(url: string): string | null {
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|(?:[^/@]+@)?github\.com:)([^/]+)\/([^/]+?)\/?$/i.exec(
      url,
    );
  return match ? `${match[1]}/${match[2]!.replace(/\.git$/i, '')}` : null;
}

/** Local-only origin identity; works without a token or a network connection. */
export async function originRepository(repo: GitRepo): Promise<string | null> {
  const origin = (await repo.remotes()).find((r) => r.name === 'origin');
  return origin ? githubRepository(origin.url) : null;
}

/**
 * The GitHub repository pull requests are looked up in: `origin`, or the only GitHub remote
 * when origin is not one. Any other layout has to name the pull request by url.
 */
async function baseRepository(repo: GitRepo | null): Promise<string> {
  if (!repo) throw new GithubError('not in a git repository; name the pull request by url', 400);
  const remotes = (await repo.remotes()).flatMap((r) => {
    const repository = githubRepository(r.url);
    return repository ? [{ name: r.name, repository }] : [];
  });
  const base = remotes.find((r) => r.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : undefined);
  if (!base) {
    const detail = remotes.length ? `${remotes.length} GitHub remotes and no origin` : 'no GitHub remote';
    throw new GithubError(`${detail}; name the pull request by url`, 400);
  }
  return base.repository;
}

/** The base repository the pull request lives in, taken from its url (a fork's own remote is not it). */
export function repoOfPrUrl(url: string): { owner: string; repo: string } {
  const parsed = parsePrUrl(url);
  if (!parsed) throw new GithubError(`cannot read owner/repo from the pull request url: ${url}`, 502);
  return { owner: parsed.owner, repo: parsed.repo };
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(pathname);
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

/** A pull request as GitHub reports it, plus the base repository derived from its URL. */
export interface PullRequest extends GithubPullRequest {
  baseRefOid: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  /** Source repository; null when GitHub no longer exposes the deleted fork. */
  headRepository: string | null;
}

const PR_FIELDS =
  'number url title state isDraft baseRefOid baseRefName headRefName headRefOid headRepository{name owner{login}}';

const BY_NUMBER = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){${PR_FIELDS}}}
}`;

const BY_HEAD = `query($owner:String!,$repo:String!,$head:String!,$base:String){
  repository(owner:$owner,name:$repo){pullRequests(headRefName:$head,baseRefName:$base,states:[OPEN],first:100){nodes{${PR_FIELDS}}}}
}`;

/**
 * The pull request a selector names: a number, `#number`, a URL, a branch (`owner:branch`
 * for a fork's), or, without one, the checked-out branch's. Everything but a URL is
 * looked up in the base repository (see `baseRepository`). Option-shaped selectors are refused.
 */
export async function viewPr(
  selector: string | undefined,
  repo: GitRepo | null,
  github: GithubClient,
  timeoutMs?: number,
): Promise<PullRequest> {
  if (selector == null) {
    if (!repo) throw new GithubError('not in a git repository; name the pull request by url', 400);
    const ref = await repo.branchRef('HEAD');
    if (!ref?.startsWith('refs/heads/'))
      throw new GithubError('HEAD is not on a branch; name the pull request by number or url', 400);
    const upstream = await repo.upstreamBranch('HEAD');
    const remotes = await repo.remotes();
    const remoteUrl = upstream && remotes.find((r) => r.name === upstream.remote)?.url;
    const headRepo = remoteUrl ? githubRepository(remoteUrl) : null;
    return byHead(github, await baseRepository(repo), upstream?.branch ?? ref.slice('refs/heads/'.length), {
      owner: headRepo?.split('/')[0],
      timeoutMs,
    });
  }
  const s = selector.trim();
  if (s.startsWith('-')) throw new GithubError(`not a pull request: ${selector}`, 400);
  const url = /^https?:\/\//.test(s) ? parsePrUrl(s) : null;
  if (url) return byNumber(github, `${url.owner}/${url.repo}`, url.number, timeoutMs);
  if (/^https?:\/\//.test(s)) throw new GithubError(`not a pull request url: ${selector}`, 400);
  const num = /^#?(\d+)$/.exec(s);
  if (num) return byNumber(github, await baseRepository(repo), Number(num[1]), timeoutMs);
  const colon = s.indexOf(':');
  const owner = colon > 0 ? s.slice(0, colon) : undefined;
  return byHead(github, await baseRepository(repo), colon > 0 ? s.slice(colon + 1) : s, { owner, timeoutMs });
}

async function byNumber(github: GithubClient, repository: string, number: number, timeoutMs?: number) {
  const [owner, repo] = repository.split('/');
  const data = await github.graphql<{ repository?: { pullRequest?: unknown } | null }>(
    BY_NUMBER,
    { owner, repo, number },
    { timeoutMs },
  );
  if (!data.repository?.pullRequest) throw new GithubError(`no pull request ${repository}#${number}`, 409);
  return parsePullRequest(data.repository.pullRequest);
}

async function byHead(
  github: GithubClient,
  baseRepo: string,
  head: string,
  { owner, timeoutMs }: { owner?: string; timeoutMs?: number },
): Promise<PullRequest> {
  const label = owner ? `${owner}:${head}` : head;
  const prs = (await pullRequestsForHead(github, baseRepo, head, undefined, timeoutMs)).filter(
    (pr) => !owner || pr.headRepository?.split('/')[0]?.toLowerCase() === owner.toLowerCase(),
  );
  if (prs.length === 0) throw new GithubError(`no open pull request in ${baseRepo} for ${label}`, 409);
  if (prs.length > 1)
    throw new GithubError(`${prs.length} open pull requests in ${baseRepo} for ${label}; open one by number`, 409);
  return prs[0]!;
}

/** Open pull requests of `baseRepo` whose head is the named branch, from any head repository, into `base` if given. */
export async function pullRequestsForHead(
  github: GithubClient,
  baseRepo: string,
  head: string,
  base?: string,
  timeoutMs?: number,
): Promise<PullRequest[]> {
  const [owner, repo] = baseRepo.split('/');
  const data = await github.graphql<{ repository?: { pullRequests?: { nodes?: unknown[] } | null } | null }>(
    BY_HEAD,
    { owner, repo, head, base: base ?? null },
    { timeoutMs },
  );
  const nodes = data.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) throw new GithubError('unexpected pull request data from GitHub', 502);
  return nodes.map(parsePullRequest);
}

function parsePullRequest(value: unknown): PullRequest {
  const pr = value as Partial<PullRequest>;
  const ok =
    pr != null &&
    typeof pr.title === 'string' &&
    ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state ?? '') &&
    typeof pr.isDraft === 'boolean' &&
    typeof pr.baseRefOid === 'string' &&
    typeof pr.number === 'number' &&
    typeof pr.url === 'string' &&
    typeof pr.baseRefName === 'string' &&
    typeof pr.headRefName === 'string' &&
    typeof pr.headRefOid === 'string';
  if (!ok) throw new GithubError('unexpected pull request data from GitHub', 502);
  const slug = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(pr.url!);
  if (!slug) throw new GithubError(`cannot read the repository from the pull request url: ${pr.url}`, 502);
  const source = value as { headRepository?: { name?: string; owner?: { login?: string } | null } | null };
  const owner = source.headRepository?.owner?.login;
  const name = source.headRepository?.name;
  return {
    headRepository: typeof owner === 'string' && typeof name === 'string' ? `${owner}/${name}` : null,
    number: pr.number!,
    url: pr.url!,
    title: pr.title!,
    state: pr.state!,
    isDraft: pr.isDraft!,
    repository: slug[1]!,
    baseRefOid: pr.baseRefOid!,
    baseRefName: pr.baseRefName!,
    headRefName: pr.headRefName!,
    headRefOid: pr.headRefOid!,
  };
}
