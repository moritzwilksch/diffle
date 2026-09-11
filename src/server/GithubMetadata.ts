import type { GithubMetadata, Snapshot } from '../shared/protocol.js';
import { GitError, type GitRepo } from './git/GitRepo.js';
import { GithubError, listPrsForHead, viewPr, runGh, type GhRunner, type PullRequest } from './github.js';

const LOOKUP_TIMEOUT_MS = 5000;

/** GitHub.com identity from a configured HTTPS, SSH, or scp-style remote URL. */
export function githubRepository(url: string): string | null {
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|(?:[^/@]+@)?github\.com:)([^/]+)\/([^/]+?)\/?$/i.exec(
      url,
    );
  return match ? `${match[1]}/${match[2]!.replace(/\.git$/i, '')}` : null;
}

/** Local-only origin identity; works without gh, authentication, or a network connection. */
export async function originRepository(repo: GitRepo): Promise<string | null> {
  const origin = (await repo.remotes()).find((r) => r.name === 'origin');
  return origin ? githubRepository(origin.url) : null;
}

/** Enriches a comparison without fetching commits, changing its endpoints, or changing comment storage. */
export async function discoverGithub(
  repo: GitRepo,
  snap: Snapshot,
  { run = runGh, prUrl }: { run?: GhRunner; prUrl?: string } = {},
): Promise<GithubMetadata> {
  const repository = await originRepository(repo);
  const absent = (reason: string): GithubMetadata => ({
    version: snap.version,
    repository,
    pullRequest: null,
    reason,
  });
  try {
    let pr: PullRequest;
    if (prUrl) {
      pr = await viewPr(prUrl, repo.root, run, LOOKUP_TIMEOUT_MS);
    } else {
      const [old, next, remotes] = await Promise.all([
        repo.upstreamBranch(snap.mode.old),
        repo.upstreamBranch(snap.mode.new),
        repo.remotes(),
      ]);
      if (!old || !next) return absent('No branch with an upstream available for both endpoints');
      const repository = (remote: string) => {
        const url = remotes.find((r) => r.name === remote)?.url;
        return url ? githubRepository(url) : null;
      };
      const baseRepo = repository(old.remote);
      const headRepo = repository(next.remote);
      if (!baseRepo || !headRepo) return absent('Both branches must have GitHub remotes');
      const prs = await listPrsForHead(baseRepo, old.branch, next.branch, headRepo, repo.root, run, LOOKUP_TIMEOUT_MS);
      if (!prs.length) return absent('No matching pull request');
      if (prs.length !== 1) return absent('Multiple matching pull requests; open one explicitly');
      pr = prs[0]!;
    }
    let reason: string | null = null;
    if (pr.state !== 'OPEN') reason = 'The pull request is not open';
    else if (snap.oldSha === 'worktree' || snap.newSha === 'worktree')
      reason = 'GitHub cannot anchor comments to the worktree';
    else if (snap.newSha !== pr.headRefOid) reason = 'The comparison does not end at the pull request head';
    else {
      try {
        if (snap.oldSha !== (await repo.mergeBase(pr.baseRefOid, pr.headRefOid)))
          reason = 'The comparison does not match the pull request diff';
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        reason = 'Fetch the pull request base to verify its diff';
      }
    }
    return {
      version: snap.version,
      repository,
      pullRequest: {
        repository: pr.repository,
        number: pr.number,
        url: pr.url,
        title: pr.title,
        state: pr.state,
        isDraft: pr.isDraft,
      },
      reason,
    };
  } catch (error) {
    if (!(error instanceof GithubError)) throw error;
    return absent(`Lookup failed: ${error.message}`);
  }
}
