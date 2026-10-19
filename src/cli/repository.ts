import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, GitRepo } from '@/server/git/GitRepo.js';
import { GithubError, noToken } from '@/server/github/client.js';
import type { Github } from '@/server/github/hosts.js';
import { viewPr } from '@/server/github/pulls.js';
import { remoteSlug } from '@/server/mode/resolve.js';
import type { EntryRequest } from '@/shared/protocol.js';

/**
 * Foreign PRs live in a disposable clone, never in the caller's object database. `connect`
 * finds the run's GitHub from the local repository, when there is one.
 */
export async function openReviewRepository<G extends Github>(
  req: EntryRequest,
  cwd: string,
  connect: (local: GitRepo | null) => Promise<G>,
): Promise<{
  repo: GitRepo;
  close: () => Promise<void>;
  github: G;
}> {
  let local: GitRepo | undefined;
  try {
    local = await GitRepo.open(cwd);
  } catch (e) {
    if (!(e instanceof GitError && e.code === 128 && req.kind === 'pr' && /^https?:\/\//.test(req.pr ?? ''))) throw e;
  }
  const github = await connect(local ?? null);
  if (req.kind !== 'pr') return { repo: local!, close: () => local!.cleanReviewRefs(), github };
  if (!github.client) throw new GithubError(noToken(github.instance.host));
  const pr = await viewPr(req.pr, local ?? null, github.client, github.instance);
  const matches = local && (await local.remotes()).some((r) => remoteSlug(r.url) === pr.repository.toLowerCase());
  if (matches) return { repo: local!, close: () => local!.cleanReviewRefs(), github };

  const dir = await mkdtemp(join(tmpdir(), 'diffle-pr-'));
  const close = () => rm(dir, { recursive: true, force: true });
  try {
    const repo = await GitRepo.clone(pr.url.slice(0, pr.url.indexOf('/pull/')), dir);
    // Keep numberless and branch selectors tied to the original PR in the clone.
    req.pr = pr.url;
    return { repo, close, github };
  } catch (e) {
    await close();
    throw e;
  }
}
