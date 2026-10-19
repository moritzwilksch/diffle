import type { GitRepo } from '@/server/git/GitRepo.js';
import type { GithubClient } from './client.js';

/**
 * The one GitHub a run talks to: github.com, a GitHub Enterprise Server, or a GHE.com tenant.
 * Remotes on other hosts are not GitHub for that run.
 */
export interface GithubInstance {
  /** Web host: pull request urls, the UI, the API, `gh auth token --hostname`. */
  host: string;
  /** Hosts of remote urls that point at it; the web host is always one. */
  gitHosts: string[];
}

export const GITHUB_COM: GithubInstance = { host: 'github.com', gitHosts: ['github.com'] };

/** A run's GitHub: where it is, and a client when there is a token for it. */
export interface Github {
  instance: GithubInstance;
  client?: GithubClient;
}

/** github.com without a token: what a run that never configured GitHub sees. */
export const TOKENLESS_GITHUB_COM: Github = { instance: GITHUB_COM };

/** `<owner>/<repo>` of a configured HTTPS, SSH, or scp-style remote url on `instance`. */
export function githubRepository(url: string, instance: GithubInstance): string | null {
  const remote = parseRemote(url);
  return remote && instance.gitHosts.includes(remote.host) ? remote.repository : null;
}

function parseRemote(url: string): { host: string; repository: string } | null {
  const match =
    /^(?:(?:https?|ssh|git\+ssh):\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/|(?:[^/@]+@)?([^/:]+):)([^/]+)\/([^/]+?)\/?$/i.exec(
      url,
    );
  if (!match) return null;
  return { host: (match[1] ?? match[2]!).toLowerCase(), repository: `${match[3]}/${match[4]!.replace(/\.git$/i, '')}` };
}

/** REST root; Octokit puts GraphQL beside it. */
export function apiBaseUrl({ host }: GithubInstance): string {
  if (host === 'github.com') return 'https://api.github.com';
  if (host.endsWith('.ghe.com')) return `https://api.${host}`;
  return `https://${host}/api/v3`;
}

/**
 * The instance whose web host is `host`: github.com, plus every `githubHosts` entry (git host →
 * web host, as in `diffle config set-github-host`) that maps to it.
 */
function instanceAt(host: string, githubHosts: Record<string, string>): GithubInstance {
  const gitHosts = Object.entries(githubHosts)
    .filter(([, web]) => web === host)
    .map(([git]) => git);
  return { host, gitHosts: [...new Set([host, ...gitHosts])] };
}

/**
 * Where a run's GitHub is: a pull request url's host, else origin's, else the one host all
 * GitHub remotes share, else github.com. A remote is GitHub when its host is github.com or a
 * configured git or web host.
 */
export async function chooseInstance(
  githubHosts: Record<string, string>,
  repo: GitRepo | null,
  prSelector?: string,
): Promise<GithubInstance> {
  if (prSelector && /^https?:\/\//i.test(prSelector)) {
    try {
      const host = new URL(prSelector).host.toLowerCase();
      return instanceAt(githubHosts[host] ?? host, githubHosts);
    } catch {
      // Not a url after all; viewPr says so.
    }
  }
  const known = new Set(['github.com', ...Object.keys(githubHosts), ...Object.values(githubHosts)]);
  const remotes = (await repo?.remotes()) ?? [];
  const hostOf = (url: string) => {
    const host = parseRemote(url)?.host;
    return host && known.has(host) ? (githubHosts[host] ?? host) : null;
  };
  const origin = remotes.find((r) => r.name === 'origin');
  const fromOrigin = origin && hostOf(origin.url);
  if (fromOrigin) return instanceAt(fromOrigin, githubHosts);
  const hosts = new Set(remotes.flatMap((r) => hostOf(r.url) ?? []));
  return hosts.size === 1 ? instanceAt([...hosts][0]!, githubHosts) : GITHUB_COM;
}
