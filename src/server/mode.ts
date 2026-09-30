import type { ModeRequest, ModeSpec } from '../shared/protocol.js';
import { GitError, type GitRepo } from './git/GitRepo.js';
import { type GithubClient, GithubError, NO_TOKEN } from './github/client.js';
import { githubRepository, type PullRequest, viewPr } from './github/pulls.js';
import { type ParsedRevspec, parseRevspec, RevspecError } from './revspec.js';

/**
 * Resolves a comparison to Git endpoints for initial mode setup, PR setup after
 * fetching, and snapshot refreshes. Revisions become full hashes; "worktree"
 * is accepted on either side and stays literal unless replaced by a merge base.
 *
 * With main at C and HEAD at E, sharing ancestor B:
 *   A--B--C  main
 *       \--D--E  HEAD
 *
 *   old       new       base        oldSha      newSha     live
 *   main      HEAD      direct      C           E          refs
 *   main      HEAD      merge-base  B           E          refs
 *   HEAD      worktree  direct      E           worktree   worktree
 *   worktree  HEAD      direct      worktree    E          worktree
 *   main      worktree  merge-base  B           worktree   worktree
 *   <C hash>  <E hash>  direct      C           E          none
 *   <E hash>  <E hash>  parent      D           E          none
 *
 * merge-base replaces only the old endpoint with the common ancestor, using
 * HEAD for any worktree input; parent replaces it with new's first parent, or
 * the empty tree for a root commit. live is "worktree" if either input is
 * worktree, "none" if both inputs are pinned hashes, and "refs" otherwise.
 *
 * In an unborn repository, HEAD compared directly with worktree resolves to
 * the empty tree. Invalid revisions or missing merge bases throw RevspecError.
 */
export async function resolveComparison(
  repo: GitRepo,
  comparison: Pick<ModeSpec, 'old' | 'new' | 'base'>,
): Promise<{ oldSha: string; newSha: string; live: ModeSpec['live'] }> {
  const endpoints = [comparison.old, comparison.new];
  const resolve = async (rev: string): Promise<string> => {
    if (rev === 'worktree') return rev;
    try {
      return await repo.resolve(rev);
    } catch (e) {
      if (
        comparison.base === 'direct' &&
        rev === 'HEAD' &&
        endpoints.includes('worktree') &&
        e instanceof GitError &&
        e.code === 1
      )
        return repo.emptyTree();
      if (e instanceof GitError) throw new RevspecError(`unknown revision: ${rev}`);
      throw e;
    }
  };
  const [old, next] = await Promise.all([resolve(comparison.old), resolve(comparison.new)]);
  let oldSha = old;
  if (comparison.base === 'merge-base') {
    const [a, b] = await Promise.all([
      old === 'worktree' ? resolve('HEAD') : old,
      next === 'worktree' ? resolve('HEAD') : next,
    ]);
    try {
      oldSha = await repo.mergeBase(a, b);
    } catch (e) {
      if (e instanceof GitError)
        throw new RevspecError(`no merge base between ${comparison.old} and ${comparison.new}`);
      throw e;
    }
  }
  if (comparison.base === 'parent') {
    if (next === 'worktree') throw new RevspecError('the worktree is not a commit');
    oldSha = await repo.resolve(`${next}^`).catch((e: unknown) => {
      if (e instanceof GitError && e.code === 1) return repo.emptyTree();
      throw e;
    });
  }
  const pinned = (rev: string, sha: string) => rev.length >= 7 && sha.startsWith(rev.toLowerCase());
  return {
    oldSha,
    newSha: next,
    live: endpoints.includes('worktree')
      ? 'worktree'
      : pinned(comparison.old, old) && pinned(comparison.new, next)
        ? 'none'
        : 'refs',
  };
}

/** Server-only transition result; PR identity is separate from the comparison sent to the client. */
export interface ResolvedReview {
  mode: ModeSpec;
  prUrl?: string;
}

/** Resolves an input command into a comparison and optional explicit PR identity. */
export async function resolveReview(req: ModeRequest, repo: GitRepo, github?: GithubClient): Promise<ResolvedReview> {
  if (req.kind === 'pr') return resolvePr(req, repo, github);
  const parsed: ParsedRevspec =
    req.kind === 'working' ? { old: 'HEAD', new: 'worktree', base: 'direct' } : parseRevspec(req.args);
  // A commit is pinned when entered: moving the ref it was named by, e.g. amending HEAD, makes a different commit.
  if (parsed.base === 'parent') {
    const { newSha: sha } = await resolveComparison(repo, parsed);
    return { mode: { old: sha, new: sha, base: 'parent', live: 'none', commentKey: `commit:${sha}` } };
  }
  const { oldSha, newSha, live } = await resolveComparison(repo, parsed);
  return {
    mode: {
      ...parsed,
      live,
      commentKey: req.kind === 'working' ? 'working' : await commentKey(repo, parsed, oldSha, newSha),
    },
  };
}

/**
 * Branch identities keep review state stable across pushes and local branch aliases.
 * Keys read like the comparison, with ... for a merge base and .. otherwise.
 * For origin = github.com/o/r and HEAD on feat tracking origin/feat:
 *   origin/main...HEAD → range:o/r:main...o/r:feat
 *   origin/main..HEAD  → range:o/r:main..o/r:feat
 * The matching explicit PR uses the first key too. If feat tracks a fork,
 * its identity becomes e.g. "contributor/r:feat", keeping forks distinct.
 *
 * Without a GitHub upstream, branches use full refs:
 *   main...feat → range:refs/heads/main...refs/heads/feat
 * Non-branch endpoints use their resolved hash or literal "worktree":
 *   main..worktree → range:refs/heads/main..worktree
 *   <C>..<E>       → range:<C hash>..<E hash>
 * Hash placeholders denote full resolved hashes, with oldSha already adjusted
 * for the merge base. The working command bypasses this helper and uses
 * "working"; a single commit uses "commit:<hash>".
 */
async function commentKey(repo: GitRepo, comparison: ParsedRevspec, oldSha: string, newSha: string): Promise<string> {
  const remotes = await repo.remotes();
  const identity = async (rev: string): Promise<string | null> => {
    const upstream = await repo.upstreamBranch(rev);
    if (upstream) {
      const url = remotes.find((remote) => remote.name === upstream.remote)?.url;
      const repository = url && githubRepository(url);
      if (repository) return `${repository.toLowerCase()}:${upstream.branch}`;
    }
    return repo.branchRef(rev);
  };
  const [old, next] = await Promise.all([identity(comparison.old), identity(comparison.new)]);
  return rangeKey(old ?? oldSha, next ?? newSha, comparison.base === 'merge-base');
}

function rangeKey(old: string, next: string, mergeBase: boolean): string {
  return `range:${old}${mergeBase ? '...' : '..'}${next}`;
}

/**
 * A GitHub pull request, as GitHub shows it: merge-base(base tip, head) vs head.
 * GitHub names the PR, then one fetch brings the base tip and the PR head into
 * session-owned refs named after the branches, so a PR nobody has checked out
 * is reviewable. These refs stay fixed until another fetch; review state uses
 * the same branch identities as ordinary comparisons, so comments survive
 * pushes and reopening by branch.
 */
async function resolvePr(
  req: { kind: 'pr'; pr?: string },
  repo: GitRepo,
  github?: GithubClient,
): Promise<ResolvedReview> {
  if (!github) throw new GithubError(NO_TOKEN);
  const pr = await viewPr(req.pr, repo, github);

  const head = `${repo.reviewRefs}/${pr.number}/head/${pr.headRefName}`;
  const base = `${repo.reviewRefs}/${pr.number}/base/${pr.baseRefName}`;
  await repo.fetch(await fetchSource(repo, pr), [
    `+refs/pull/${pr.number}/head:${head}`,
    `+refs/heads/${pr.baseRefName}:${base}`,
  ]);
  await resolveComparison(repo, { old: base, new: head, base: 'merge-base' });
  return {
    prUrl: pr.url,
    mode: {
      old: base,
      new: head,
      base: 'merge-base',
      live: 'none',
      commentKey: rangeKey(
        `${pr.repository.toLowerCase()}:${pr.baseRefName}`,
        `${pr.headRepository?.toLowerCase() ?? `deleted:${pr.url}`}:${pr.headRefName}`,
        true,
      ),
    },
  };
}

/**
 * `refs/pull/*` lives on the base repository, so the fetch goes to the remote
 * that points at it. Foreign repositories must be opened separately by the CLI.
 */
async function fetchSource(repo: GitRepo, pr: PullRequest): Promise<string> {
  const slug = pr.repository.toLowerCase();
  const match = (await repo.remotes()).find((r) => remoteSlug(r.url) === slug);
  if (!match) throw new RevspecError(`foreign repository; open it with diffle pr ${pr.url}`);
  return match.name;
}

/** `<owner>/<repo>`, lowercased, from an https or scp-style remote url. */
export function remoteSlug(url: string): string {
  return url
    .replace(/\.git$/, '')
    .toLowerCase()
    .split(/[/:]/)
    .slice(-2)
    .join('/');
}
