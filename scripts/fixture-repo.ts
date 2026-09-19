// Build the fixture repository for hands-on testing: `npm run fixture -- [dir]`.
//
// The same history the e2e tests review, checked out with uncommitted changes, so every
// mode diffle offers has something to show. Without a directory it lands in the system
// temp directory and is replaced on every run.
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildFixtureRepo, REVIEWS } from '../test/fixture/repo.js';

const dir = resolve(process.argv[2] ?? `${tmpdir()}/diffle-fixture`);
const { refs } = await buildFixtureRepo(dir);

const width = Math.max(...REVIEWS.map((r) => r.revs.length));
console.log(`Fixture repository built at ${dir}\n`);
for (const [ref, sha] of Object.entries(refs)) console.log(`  ${ref.padEnd(width)}  ${sha.slice(0, 12)}`);
console.log('\nOpen it with one of:\n');
for (const { revs, shows } of REVIEWS) {
  console.log(`  npm run dev -- -C ${dir} ${revs.padEnd(width)}  # ${shows}`);
}
console.log('\nA published build reviews it the same way: diffle -C <dir> <revs>.');
