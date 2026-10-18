import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { realExecutable } from './which.js';

/**
 * The TypeScript `lib` directory a Volar server such as astro-ls loads as its
 * `typescript.tsdk`, or null when none is found. The repository's own `typescript`
 * wins, so the server reads code with the project's version; after it, the one
 * installed beside the first of `executables` that has one. Node's resolution from an
 * executable's real location reaches the package in the layouts of npm (hoisted under
 * `lib/node_modules`), a Windows `.cmd` shim (beside `node_modules`) and nixpkgs (the
 * pnpm store the symlink's target sits in). A conda or pixi environment runs a launcher
 * in `bin`, so each package under its `lib/node_modules` is tried as well, where the
 * TypeScript is nested or hoisted. TypeScript 7 ships no `typescript.js`, so it is
 * passed over: Volar cannot load the Go port.
 */
export function tsdkLocation(root: string, executables: (string | null)[]): string | null {
  const bases = [root];
  for (const executable of executables) {
    if (executable == null) continue;
    const bin = dirname(realExecutable(executable));
    bases.push(bin, ...globalPackages(resolve(bin, '..', 'lib', 'node_modules')));
  }
  for (const base of bases) {
    const lib = typescriptLib(base);
    if (lib) return lib;
  }
  return null;
}

/** The package directories under a global `node_modules`, scoped ones included; none when it is not there. */
function globalPackages(modules: string): string[] {
  const entries = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
    } catch {
      return [];
    }
  };
  return entries(modules).flatMap((name) =>
    name.startsWith('@') ? entries(join(modules, name)).map((sub) => join(modules, name, sub)) : [join(modules, name)],
  );
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
