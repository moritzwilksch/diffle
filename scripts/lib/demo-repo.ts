// The repository the README demo reviews: a URL shortener on `main`, and a `rate-limit` branch that
// adds a token bucket. It is the same repository diffle.app records its videos from
// (`scripts/demo-repo.ts` in glattziehen/diffle-website), so the README and the site tell one story.
// Author, dates, and content are fixed, so every run produces the same commits and the same diff.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FEATURE_COMMITS, type Files, MAIN_FILES } from './demo-repo-files.js';

export const BASE = 'main';
export const FEATURE = 'rate-limit';

function writeFiles(repo: string, files: Files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

/** Create the demo repository in `repo` (a new or empty directory), checked out on the feature branch. */
export function buildDemoRepo(repo: string) {
  mkdirSync(repo, { recursive: true });
  let tick = 0;
  const git = (...args: string[]) => {
    // One minute per commit from a fixed epoch keeps hashes identical across runs.
    const date = new Date(Date.UTC(2026, 8, 14, 9, tick)).toISOString();
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'Sam Reviewer',
        GIT_AUTHOR_EMAIL: 'sam@example.com',
        GIT_COMMITTER_NAME: 'Sam Reviewer',
        GIT_COMMITTER_EMAIL: 'sam@example.com',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
  };
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '--quiet', '--no-gpg-sign', '-m', message);
    tick++;
  };

  git('init', '--quiet', '--initial-branch', BASE);
  writeFiles(repo, MAIN_FILES);
  commit('feat: shorten and follow links');
  git('checkout', '--quiet', '-b', FEATURE);
  for (const { message, files } of FEATURE_COMMITS) {
    writeFiles(repo, files);
    commit(message);
  }
}
