import license, { type Dependency } from 'rollup-plugin-license';

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
