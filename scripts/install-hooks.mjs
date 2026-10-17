// Runs from `npm install` (the prepare script): points git at .githooks so the quality gate guards every commit.
// A source tarball or a Nix build has no .git, so there is nothing to hook.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  } catch (error) {
    // An unwritable .git/config must not fail the install; CI runs the same check.
    console.warn(`could not enable the pre-commit hook: ${error.message}`);
  }
}
