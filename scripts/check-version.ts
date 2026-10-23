// Fails when the crate's version (manifest or lockfile) or the conda recipe's drifts from package.json's.
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const expected = (JSON.parse(read('package.json')) as { version: string }).version;
const found = {
  'crates/diffle/Cargo.toml': /^version = "([^"]*)"/m.exec(read('crates/diffle/Cargo.toml'))?.[1],
  'Cargo.lock': /^name = "diffle"\nversion = "([^"]*)"/m.exec(read('Cargo.lock'))?.[1],
  'recipe/recipe.yaml': /^  version: "([^"]*)"/m.exec(read('recipe/recipe.yaml'))?.[1],
};
const drifted = Object.entries(found).filter(([, version]) => version !== expected);
for (const [path, version] of drifted) {
  console.error(`${path} has version ${version ?? '(none)'}, package.json has ${expected}`);
}
process.exit(drifted.length ? 1 : 0);
