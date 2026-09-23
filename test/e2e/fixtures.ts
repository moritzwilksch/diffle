// Playwright fixtures: every test gets its own fixture repository and its own diffle, so
// review state (threads, viewed marks) never leaks between scenarios and each one can pick
// the comparison it needs with `test.use({ revs: [...] })`.
import { test as base, expect, type Locator } from '@playwright/test';
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureRepo, FEATURE_BRANCH, MAIN_BRANCH } from '../fixture/repo.js';
import { rmTmp } from '../tmp.js';
import { type RunningDiffle, startDiffle } from './server.js';
import { settle } from './browser.js';

/** Name of the checkout, and so of the repository in the header. */
export const REPO_NAME = 'tally';

export interface Options {
  /** Command-line revisions; the merge-base view of the feature branch by default. */
  revs: string[];
  /** Further command-line flags. */
  args: string[];
  /** Extra environment for the diffle process. */
  env: NodeJS.ProcessEnv;
}

export interface Fixtures {
  /** An isolated copy of the fixture repository, removed after the test. */
  repo: string;
  /** A diffle reviewing `repo`; stopped after the test. */
  diffle: RunningDiffle;
}

interface WorkerFixtures {
  fixtureTemplate: string;
}

export const test = base.extend<Options & Fixtures, WorkerFixtures>({
  revs: [[`${MAIN_BRANCH}...${FEATURE_BRANCH}`], { option: true }],
  args: [[], { option: true }],
  env: [{}, { option: true }],

  // Copy the complete checkout, including staged/unstaged files; git clone would lose working-mode inputs.
  fixtureTemplate: [
    // Playwright's idiom for a fixture without dependencies.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const dir = await mkdtemp(join(tmpdir(), 'diffle-e2e-template-'));
      try {
        await buildFixtureRepo(dir);
        await use(dir);
      } finally {
        await rmTmp(dir);
      }
    },
    { scope: 'worker' },
  ],

  repo: async ({ fixtureTemplate }, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'diffle-e2e-'));
    try {
      const repo = join(dir, REPO_NAME);
      await cp(fixtureTemplate, repo, { recursive: true });
      await use(repo);
    } finally {
      await rmTmp(dir);
    }
  },

  diffle: async ({ repo, revs, args, env }, use) => {
    const server = await startDiffle({ repo, revs, args, env });
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },

  /** Already on the review, fonts loaded and the first file rendered. */
  page: async ({ page, diffle }, use) => {
    await page.goto(diffle.url);
    await settle(page);
    await use(page);
  },
});

export { expect };

/**
 * The accessibility tree of `locator` against its stored `.aria.yml`. Checked once per scenario,
 * in the light project: structure does not depend on the colour scheme, and a second copy of the
 * same YAML would only double the review.
 */
export async function expectAria(locator: Locator, name: string): Promise<void> {
  if (test.info().project.name !== 'light') return;
  await expect(locator).toMatchAriaSnapshot({ name: `${name}.aria.yml` });
}
