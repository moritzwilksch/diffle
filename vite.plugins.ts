import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, gzipSync } from 'node:zlib';
import license, { type Dependency } from 'rollup-plugin-license';
import type { Plugin } from 'vite';

/** The licences a bundled package may carry; compared ignoring case, as package.json files spell SPDX ids freely. */
const ACCEPTED_LICENSES = ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD'];

/**
 * Writes every package a bundle pulled in to `file`, as `template` words them. A package under
 * another licence fails the build: accept it here on purpose, or drop the package.
 */
export function licenses(file: string, template: (dependencies: Dependency[]) => string) {
  return license({
    thirdParty: {
      multipleVersions: true,
      allow: {
        test: (d) => ACCEPTED_LICENSES.some((id) => id.toLowerCase() === d.license?.toLowerCase()),
        failOnUnlicensed: true,
        failOnViolation: true,
      },
      output: { file, template },
    },
  });
}

// The binary embeds the client as gzip, which every browser accepts over plain HTTP (brotli only over
// HTTPS): `x.js` becomes `x.js.gz` and the server sends it encoded. Fonts are compressed already.
const COMPRESSIBLE = /\.(?:html|js|css|svg|json|wasm|txt)$/;

/** Replaces each text file the build wrote under `outDir` with its gzipped copy, as the binary embeds it. */
export const gzipAssets = (outDir: string): Plugin => ({
  name: 'diffle:gzip-assets',
  apply: 'build',
  // Not `closeBundle`: it also runs after a failed build, and would hide that build's error.
  writeBundle() {
    for (const name of readdirSync(outDir, { recursive: true, encoding: 'utf8' })) {
      if (!COMPRESSIBLE.test(name)) continue;
      const path = join(outDir, name);
      writeFileSync(`${path}.gz`, gzipSync(readFileSync(path), { level: constants.Z_BEST_COMPRESSION }));
      unlinkSync(path);
    }
  },
});
