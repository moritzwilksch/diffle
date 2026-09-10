import type { ModeRequest, ModeSpec } from '../shared/protocol.js';
import { GitError, type GitRepo } from './git/GitRepo.js';
import { type GhRunner, type PullRequest, runGh, viewPr } from './github.js';
import { parseRevspec, RevspecError } from './revspec.js';

async function resolveOrExplain(repo: GitRepo, rev: string): Promise<string> {
  try {
    return await repo.resolve(rev);
  } catch (e) {
    if (e instanceof GitError) throw new RevspecError(`unknown revision: ${rev}`);
    throw e;
  }
}

async function mergeBaseOrExplain(repo: GitRepo, a: string, b: string): Promise<string> {
  await Promise.all([resolveOrExplain(repo, a), resolveOrExplain(repo, b)]);
  try {
    return await repo.mergeBase(a, b);
  } catch (e) {
    if (e instanceof GitError) throw new RevspecError(`no merge base between ${a} and ${b}`);
    throw e;
  }
}

/** Resolves a request locally, except for an explicitly requested PR. */
export async function resolveMode(req: ModeRequest, repo: GitRepo, gh: GhRunner = runGh): Promise<ModeSpec> {
  if (req.kind === 'pr') return resolvePr(req, repo, gh);
  const parsed =
    req.kind === 'working'
      ? { old: 'HEAD', new: 'worktree', mergeBase: false, label: 'HEAD → worktree' }
      : parseRevspec(req.args);
  const resolve = async (rev: string) => {
    if (rev === 'worktree') return rev;
    try {
      return await repo.resolve(rev);
    } catch (e) {
      // Either direction of an unborn worktree compares against the empty tree.
      if (rev === 'HEAD' && [parsed.old, parsed.new].includes('worktree') && e instanceof GitError && e.code === 1)
        return repo.emptyTree();
      if (e instanceof GitError) throw new RevspecError(`unknown revision: ${rev}`);
      throw e;
    }
  };
  const [old, next] = await Promise.all([resolve(parsed.old), resolve(parsed.new)]);
  const oldKey = parsed.mergeBase
    ? await mergeBaseOrExplain(
        repo,
        parsed.old === 'worktree' ? 'HEAD' : parsed.old,
        parsed.new === 'worktree' ? 'HEAD' : parsed.new,
      )
    : old;
  const pinned = (rev: string, sha: string) => rev.length >= 7 && sha.startsWith(rev.toLowerCase());
  return {
    ...parsed,
    request: req,
    live: [parsed.old, parsed.new].includes('worktree')
      ? 'worktree'
      : pinned(parsed.old, old) && pinned(parsed.new, next)
        ? 'none'
        : 'refs',
    commentKey: req.kind === 'working' ? 'working' : `revspec:${oldKey}..${next}`,
  };
}

/**
 * A GitHub pull request, as GitHub shows it: merge-base(base tip, head) vs head.
 * `gh` names the PR, then one fetch brings the base tip and the PR head into
 * session-owned refs, so a PR nobody has checked out is reviewable. Both
 * sides are pinned to commits, so the mode is static and the comment key follows
 * the PR number: comments survive a force-push.
 */
async function resolvePr(req: { kind: 'pr'; pr?: string }, repo: GitRepo, gh: GhRunner): Promise<ModeSpec> {
  const pr = await viewPr(req.pr, repo.root, gh);
  return resolveKnownPr(req, repo, pr);
}

async function resolveKnownPr(req: { kind: 'pr'; pr?: string }, repo: GitRepo, pr: PullRequest): Promise<ModeSpec> {
  const head = `${repo.reviewRefs}/${pr.number}/head`;
  const base = `${repo.reviewRefs}/${pr.number}/base`;
  await repo.fetch(await fetchSource(repo, pr), [
    `+refs/pull/${pr.number}/head:${head}`,
    `+refs/heads/${pr.baseRefName}:${base}`,
  ]);
  const [headSha, mb] = await Promise.all([resolveOrExplain(repo, head), mergeBaseOrExplain(repo, base, head)]);
  return {
    request: { ...req, pr: pr.url },
    old: mb,
    new: headSha,
    mergeBase: false,
    label: `#${pr.number} ${pr.baseRefName}...${pr.headRefName}`,
    live: 'none',
    commentKey: `pr:#${pr.number}`,
  };
}

/**
 * `refs/pull/*` lives on the base repository, so the fetch goes to the remote
 * that points at it. Foreign repositories must be opened separately by the CLI.
 */
async function fetchSource(repo: GitRepo, pr: PullRequest): Promise<string> {
  const slug = pr.baseRepo.toLowerCase();
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
