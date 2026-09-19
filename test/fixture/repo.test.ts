import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';
import { buildFixtureRepo, FEATURE_BRANCH, type FixtureRepo, MAIN_BRANCH, TAG } from './repo.js';

/**
 * The history's identity. A change to `repo.ts` that alters any commit lands here first:
 * update these after checking that the change is intended, then re-accept the e2e snapshots
 * that show the fixture.
 */
const PINNED = {
  [MAIN_BRANCH]: '170cd2806e2e541bd24e4aa6b3e6e341b143dae8',
  [FEATURE_BRANCH]: '1d1351368585e680f98a5df85a9abf285d67a83e',
  [TAG]: '578ee788e83eb4acd93855eab14b9a57f8c8b9f5',
};

let dir: string;
let repo: FixtureRepo;
/** Output without its final newline; a leading space is significant in porcelain status lines. */
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: dir, encoding: 'utf8' }).replace(/\n$/, '');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-fixture-'));
  repo = await buildFixtureRepo(dir);
}, 60_000);
afterAll(() => rmTmp(dir));

describe('fixture repository', () => {
  it('hashes the same on every machine', () => {
    expect(repo.refs).toEqual(PINNED);
  });

  it('shows every diff shape between main and the feature branch', () => {
    const status = git('diff', '--name-status', '-M', `${MAIN_BRANCH}...${FEATURE_BRANCH}`);
    expect(status.split('\n')).toEqual([
      'A\tVERSION',
      'M\tassets/logo.png',
      'R100\tdocs/Übersicht.md\tdocs/guide/Übersicht.md',
      'M\trequirements.lock',
      'A\tscripts/build.bat',
      'M\tscripts/tally.sh',
      'M\ttally/cli.py',
      'R054\ttally/money.py\ttally/currency.py',
      'M\ttally/generated/openapi.py',
      'M\ttally/ledger.py',
      'D\ttally/legacy.py',
      'A\ttally/py.typed',
      'A\ttally/refunds.py',
      'M\ttally/schema.json',
      'M\ttests/test_ledger.py',
      'A\ttests/test_refunds.py',
      'A\tweb/vendor/sparkline.min.js',
    ]);
    // The mode change is the only difference in the launcher script.
    expect(git('diff', '--summary', `${MAIN_BRANCH}...${FEATURE_BRANCH}`, '--', 'scripts/tally.sh')).toBe(
      ' mode change 100644 => 100755 scripts/tally.sh',
    );
  });

  it("differs between merge-base and two-dot views by main's own fix", () => {
    const twoDot = git('diff', '--name-only', `${MAIN_BRANCH}..${FEATURE_BRANCH}`).split('\n');
    const threeDot = git('diff', '--name-only', `${MAIN_BRANCH}...${FEATURE_BRANCH}`).split('\n');
    expect(twoDot).toContain('README.md');
    expect(threeDot).not.toContain('README.md');
  });

  it('leaves a staged, an unstaged and an untracked change for working mode', () => {
    expect(git('branch', '--show-current')).toBe(FEATURE_BRANCH);
    expect(git('status', '--porcelain').split('\n')).toEqual([' M README.md', 'M  tally/refunds.py', '?? notes/']);
  });

  it('keeps CRLF and a missing trailing newline byte for byte', () => {
    expect(git('show', `${FEATURE_BRANCH}:scripts/build.bat`)).toContain('\r\n');
    expect(execFileSync('git', ['show', `${FEATURE_BRANCH}:VERSION`], { cwd: dir, encoding: 'utf8' })).toBe('0.2.0');
  });
});
