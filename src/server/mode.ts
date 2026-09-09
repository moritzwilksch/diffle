import type { ModeRequest, ModeSpec, OldSpec } from '../shared/protocol.js';
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

function isShaPrefix(rev: string, sha: string): boolean {
  return rev.length >= 7 && sha.startsWith(rev.toLowerCase());
}

/** Resolves a ModeRequest into a ModeSpec, including the comment key. */
export async function resolveMode(req: ModeRequest, repo: GitRepo, gh: GhRunner = runGh): Promise<ModeSpec> {
  switch (req.kind) {
    case 'working':
      return {
        kind: 'working',
        request: req,
        old: { kind: 'rev', rev: 'HEAD' },
        newRev: 'worktree',
        label: 'HEAD → worktree',
        live: 'worktree',
        commentKey: 'working',
      };
    case 'branch': {
      const base = req.base ? req.base : await repo.defaultBranch();
      const old: OldSpec = { kind: 'merge-base', a: base, b: 'HEAD' };
      const mb = await mergeBaseOrExplain(repo, base, 'HEAD');
      return {
        kind: 'branch',
        request: req,
        old,
        newRev: 'HEAD',
        label: `${base}...HEAD`,
        live: 'refs',
        commentKey: `branch:${mb}`,
      };
    }
    case 'pr':
      return resolvePr(req, repo, gh);
    case 'revspec': {
      const parsed = parseRevspec(req.args);
      const oldSha =
        parsed.old.kind === 'rev'
          ? await resolveOrExplain(repo, parsed.old.rev)
          : await mergeBaseOrExplain(repo, parsed.old.a, parsed.old.b);
      let live: ModeSpec['live'] = 'none';
      let newKey: string = parsed.newRev;
      if (parsed.newRev === 'worktree') live = 'worktree';
      else {
        const sha = await resolveOrExplain(repo, parsed.newRev);
        // A pinned sha never moves; anything symbolic (branch, tag, HEAD~2) can.
        if (!isShaPrefix(parsed.newRev, sha)) live = 'refs';
        newKey = sha;
      }
      return {
        kind: 'revspec',
        request: req,
        old: parsed.old,
        newRev: parsed.newRev,
        label: parsed.label,
        live,
        commentKey: `revspec:${oldSha}..${newKey}`,
      };
    }
  }
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
  const head = `${repo.reviewRefs}/${pr.number}/head`;
  const base = `${repo.reviewRefs}/${pr.number}/base`;
  await repo.fetch(await fetchSource(repo, pr), [
    `+refs/pull/${pr.number}/head:${head}`,
    `+refs/heads/${pr.baseRefName}:${base}`,
  ]);
  const [headSha, mb] = await Promise.all([resolveOrExplain(repo, head), mergeBaseOrExplain(repo, base, head)]);
  return {
    kind: 'pr',
    request: req,
    old: { kind: 'rev', rev: mb },
    newRev: headSha,
    label: `#${pr.number} ${pr.baseRefName}...${pr.headRefName}`,
    repository: pr.baseRepo,
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
