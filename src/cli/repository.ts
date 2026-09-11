import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, GitRepo } from '../server/git/GitRepo.js';
import { type GhRunner, runGh, viewPr } from '../server/github.js';
import { remoteSlug } from '../server/mode.js';
import type { ModeRequest } from '../shared/protocol.js';

/** Foreign PRs live in a disposable clone, never in the caller's object database. */
export async function openReviewRepository(
  req: ModeRequest,
  cwd: string,
  gh: GhRunner = runGh,
): Promise<{
  repo: GitRepo;
  close: () => Promise<void>;
}> {
  let local: GitRepo | undefined;
  try {
    local = await GitRepo.open(cwd);
  } catch (e) {
    if (!(e instanceof GitError && e.code === 128 && req.kind === 'pr' && /^https?:\/\//.test(req.pr ?? ''))) throw e;
  }
  if (req.kind !== 'pr') return { repo: local!, close: () => local!.cleanReviewRefs() };
  const pr = await viewPr(req.pr, cwd, gh);
  const matches = local && (await local.remotes()).some((r) => remoteSlug(r.url) === pr.repository.toLowerCase());
  if (matches) return { repo: local!, close: () => local!.cleanReviewRefs() };

  const dir = await mkdtemp(join(tmpdir(), 'diffle-pr-'));
  const close = () => rm(dir, { recursive: true, force: true });
  try {
    const repo = await GitRepo.clone(pr.url.slice(0, pr.url.indexOf('/pull/')), dir);
    // Keep numberless and branch selectors tied to the original PR in the clone.
    req.pr = pr.url;
    return { repo, close };
  } catch (e) {
    await close();
    throw e;
  }
}
