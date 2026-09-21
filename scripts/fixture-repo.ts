// Build the fixture repository for hands-on testing: `npm run fixture -- [dir]`.
//
// The same history the e2e tests review, checked out with uncommitted changes, so every
// mode diffle offers has something to show. Without a directory, create a fresh temporary one.
import { Command } from 'commander';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildFixtureRepo, FixtureDirectoryError, REVIEWS } from '../test/fixture/repo.js';

const command = new Command('fixture')
  .description('Build a demo repository in a new or empty directory.')
  .argument('[dir]', 'destination (default: a fresh temporary directory)')
  .exitOverride((error) => process.exit(error.exitCode === 0 ? 0 : 2));
command.parse();
const dir = command.args[0] ? resolve(command.args[0]) : await mkdtemp(join(tmpdir(), 'diffle-fixture-'));
const { refs } = await buildFixtureRepo(dir).catch((error: unknown) => {
  if (error instanceof FixtureDirectoryError) command.error(error.message, { exitCode: 2 });
  throw error;
});

const width = Math.max(...REVIEWS.map((r) => r.revs.length));
console.log(`Fixture repository built at ${dir}\n`);
for (const [ref, sha] of Object.entries(refs)) console.log(`  ${ref.padEnd(width)}  ${sha.slice(0, 12)}`);
console.log('\nOpen it with one of:\n');
for (const { revs, shows } of REVIEWS) {
  console.log(`  npm run dev -- -C ${dir} ${revs.padEnd(width)}  # ${shows}`);
}
console.log('\nA published build reviews it the same way: diffle -C <dir> <revs>.');
