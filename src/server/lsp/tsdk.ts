import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * The TypeScript `lib` directory a Volar server such as astro-ls loads as its
 * `typescript.tsdk`, or null when none is found. The repository's own `typescript`
 * wins, so the server reads code with the project's version; after it, the one
 * installed beside the first of `executables` that has one. Node's resolution from an
 * executable's real location reaches the package in the layouts of npm (hoisted under
 * `lib/node_modules`), a Windows `.cmd` shim (beside `node_modules`) and nixpkgs (the
 * pnpm store the symlink's target sits in). TypeScript 7 ships no `typescript.js`, so
 * it is passed over: Volar cannot load the Go port.
 */
export function tsdkLocation(root: string, executables: (string | null)[]): string | null {
  const bases = [root];
  for (const executable of executables) {
    if (executable == null) continue;
    try {
      bases.push(dirname(realpathSync(executable)));
    } catch {
      /* A dangling link leads nowhere. */
    }
  }
  for (const base of bases) {
    const lib = typescriptLib(base);
    if (lib) return lib;
  }
  return null;
}

/** `typescript/lib` as resolved from `base`, when it holds a loadable TypeScript. */
function typescriptLib(base: string): string | null {
  try {
    const lib = join(dirname(createRequire(join(base, 'package.json')).resolve('typescript/package.json')), 'lib');
    return ['typescript.js', 'tsserverlibrary.js'].some((file) => existsSync(join(lib, file))) ? lib : null;
  } catch {
    return null;
  }
}
