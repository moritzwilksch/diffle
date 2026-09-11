import type { ModeRequest, ModeSpec } from '../shared/protocol.js';
import { GitError, type GitRepo } from './git/GitRepo.js';
import { type GhRunner, type PullRequest, runGh, viewPr } from './github.js';
import { githubRepository } from './GithubMetadata.js';
import { parseRevspec, RevspecError } from './revspec.js';

/**
 * Resolves a comparison to Git endpoints for initial mode setup, PR setup after
 * fetching, and snapshot refreshes. Revisions become full hashes; "worktree"
 * is accepted on either side and stays literal unless replaced by a merge base.
 *
 * With main at C and HEAD at E, sharing ancestor B:
 *   A--B--C  main
 *       \--D--E  HEAD
 *
 *   old       new       mergeBase   oldSha      newSha     live
 *   main      HEAD      false       C           E          refs
 *   main      HEAD      true        B           E          refs
 *   HEAD      worktree  false       E           worktree   worktree
 *   worktree  HEAD      false       worktree    E          worktree
 *   main      worktree  true        B           worktree   worktree
 *   <C hash>  <E hash>  false       C           E          none
 *
 * mergeBase replaces only the old endpoint with the common ancestor, using
 * HEAD for any worktree input. live is "worktree" if either input is worktree,
 * "none" if both inputs are pinned hashes, and "refs" otherwise.
 *
 * In an unborn repository, HEAD compared directly with worktree resolves to
 * the empty tree. Invalid revisions or missing merge bases throw RevspecError.
 */
export async function resolveComparison(
  repo: GitRepo,
  comparison: Pick<ModeSpec, 'old' | 'new' | 'mergeBase'>,
): Promise<{ oldSha: string; newSha: string; live: ModeSpec['live'] }> {
  const endpoints = [comparison.old, comparison.new];
  const resolve = async (rev: string): Promise<string> => {
    if (rev === 'worktree') return rev;
    try {
      return await repo.resolve(rev);
    } catch (e) {
      if (
        !comparison.mergeBase &&
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
  if (comparison.mergeBase) {
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
export async function resolveReview(req: ModeRequest, repo: GitRepo, gh: GhRunner = runGh): Promise<ResolvedReview> {
  if (req.kind === 'pr') return resolvePr(req, repo, gh);
  const parsed = req.kind === 'working' ? { old: 'HEAD', new: 'worktree', mergeBase: false } : parseRevspec(req.args);
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
 * For origin = github.com/o/r and HEAD on feat tracking origin/feat:
 *   origin/main...HEAD → branches:["o/r:main","o/r:feat",true]
 *   origin/main..HEAD  → branches:["o/r:main","o/r:feat",false]
 * The matching explicit PR uses the first key too. If feat tracks a fork,
 * its identity becomes e.g. "contributor/r:feat", keeping forks distinct.
 *
 * Without a GitHub upstream, branches use full refs:
 *   main...feat → branches:["refs/heads/main","refs/heads/feat",true]
 * Non-branch endpoints use their resolved hash or literal "worktree":
 *   main..worktree → branches:["refs/heads/main","worktree",false]
 * If neither endpoint is a branch, the key is revspec:<oldSha>..<newSha>.
 * Hash placeholders denote full resolved hashes, with oldSha already adjusted
 * for mergeBase. The working command bypasses this helper and uses "working".
 */
async function commentKey(
  repo: GitRepo,
  comparison: Pick<ModeSpec, 'old' | 'new' | 'mergeBase'>,
  oldSha: string,
  newSha: string,
): Promise<string> {
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
  return old || next ? branchKey(old ?? oldSha, next ?? newSha, comparison.mergeBase) : `revspec:${oldSha}..${newSha}`;
}

function branchKey(old: string, next: string, mergeBase: boolean): string {
  return `branches:${JSON.stringify([old, next, mergeBase])}`;
}

/**
 * A GitHub pull request, as GitHub shows it: merge-base(base tip, head) vs head.
 * `gh` names the PR, then one fetch brings the base tip and the PR head into
 * session-owned refs named after the branches, so a PR nobody has checked out
 * is reviewable. These refs stay fixed until another fetch; review state uses
 * the same branch identities as ordinary comparisons, so comments survive
 * pushes and reopening by branch.
 */
async function resolvePr(req: { kind: 'pr'; pr?: string }, repo: GitRepo, gh: GhRunner): Promise<ResolvedReview> {
  const pr = await viewPr(req.pr, repo.root, gh);

  const head = `${repo.reviewRefs}/${pr.number}/head/${pr.headRefName}`;
  const base = `${repo.reviewRefs}/${pr.number}/base/${pr.baseRefName}`;
  await repo.fetch(await fetchSource(repo, pr), [
    `+refs/pull/${pr.number}/head:${head}`,
    `+refs/heads/${pr.baseRefName}:${base}`,
  ]);
  await resolveComparison(repo, { old: base, new: head, mergeBase: true });
  return {
    prUrl: pr.url,
    mode: {
      old: base,
      new: head,
      mergeBase: true,
      live: 'none',
      commentKey: branchKey(
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
