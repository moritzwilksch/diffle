// Playwright fixtures: every test gets its own fixture repository and its own diffle, so
// review state (threads, viewed marks) never leaks between scenarios and each one can pick
// the comparison it needs with `test.use({ revs: [...] })`.
import { test as base, expect, type Locator } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureRepo, FEATURE_BRANCH, MAIN_BRANCH } from '../fixture/repo.js';
import { rmTmp } from '../tmp.js';
import { installFonts, type RunningDiffle, settle, startDiffle } from './harness.js';

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
  /** A fresh build of the fixture repository, removed after the test. */
  repo: string;
  /** A diffle reviewing `repo`; stopped after the test. */
  diffle: RunningDiffle;
}

export const test = base.extend<Options & Fixtures>({
  revs: [[`${MAIN_BRANCH}...${FEATURE_BRANCH}`], { option: true }],
  args: [[], { option: true }],
  env: [{}, { option: true }],

  // Playwright's idiom for a fixture without dependencies.
  // oxlint-disable-next-line no-empty-pattern
  repo: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'diffle-e2e-'));
    const repo = join(dir, REPO_NAME);
    await buildFixtureRepo(repo);
    await use(repo);
    await rmTmp(dir);
  },

  diffle: async ({ repo, revs, args, env }, use) => {
    const server = await startDiffle({ repo, revs, args, env });
    await use(server);
    await server.stop();
  },

  context: async ({ context }, use) => {
    await installFonts(context);
    await use(context);
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
