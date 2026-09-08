import type { ModeRequest, ModeSpec, OldSpec } from '../shared/protocol.js';
import { GitError, type GitRepo } from './git/GitRepo.js';
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
export async function resolveMode(req: ModeRequest, repo: GitRepo): Promise<ModeSpec> {
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
    case 'branch':
    case 'pr': {
      const base = req.kind === 'branch' && req.base ? req.base : await repo.defaultBranch();
      const old: OldSpec = { kind: 'merge-base', a: base, b: 'HEAD' };
      const mb = await mergeBaseOrExplain(repo, base, 'HEAD');
      return {
        kind: req.kind,
        request: req,
        old,
        newRev: 'HEAD',
        label: `${base}...HEAD`,
        live: 'refs',
        commentKey: `${req.kind}:${mb}`,
      };
    }
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
