import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { ServerContext } from '@/server/lsp/registry.js';
import { realExecutable } from '@/server/lsp/which.js';
import type { LspProjects } from '@/shared/protocol.js';
import { shownPath } from './shown.js';

/** Programs whose installations may carry a TypeScript. */
const TSSERVER_PROGRAMS = ['typescript-language-server', 'vtsls', 'astro-ls'];

/**
 * The TypeScript `lib` a server named `program` loads: the project's, found from the
 * diff's files so a package below the root has its own, else one beside a server on
 * PATH, its own first.
 */
export function tsdk({ root, paths, lookup }: ServerContext, program: string): string | null {
  const programs = [program, ...TSSERVER_PROGRAMS.filter((p) => p !== program)];
  return tsdkLocation(
    root,
    paths,
    programs.map((p) => lookup(p)),
  );
}

/** The TypeScript `tsdk` finds, for the status: its version and package. */
export function typescriptProjects(ctx: ServerContext, program: string): LspProjects {
  const lib = tsdk(ctx, program);
  if (!lib) return { label: 'TypeScript', paths: [] };
  const version = typescriptVersion(lib);
  return { label: version ? `TypeScript ${version}` : 'TypeScript', paths: [shownPath(ctx.root, dirname(lib))] };
}

/**
 * The TypeScript `lib` directory a server loads as its tsdk, or null when none is found.
 * The project's own `typescript` wins, so the server reads code with the project's
 * version: resolved from the directory of each of `paths` (repository-relative), so a
 * package under `frontend/` finds its own, then from `root`. After it, the one installed
 * beside the first of `executables` that has one. Node's resolution from an
 * executable's real location reaches the package in the layouts of npm (hoisted under
 * `lib/node_modules`), a Windows `.cmd` shim (beside `node_modules`) and nixpkgs (the
 * pnpm store the symlink's target sits in). A conda or pixi environment runs a launcher
 * in `bin`, so each package under its `lib/node_modules` is tried as well, where the
 * TypeScript is nested or hoisted. TypeScript 7 ships no `typescript.js`, so it is
 * passed over: no tsserver client can load the Go port.
 */
export function tsdkLocation(root: string, paths: readonly string[], executables: (string | null)[]): string | null {
  // Resolution walks up `node_modules` from each base, so one base per directory reaches every ancestor.
  const bases = [...paths.map((p) => join(root, dirname(p))), root];
  for (const executable of executables) {
    if (executable == null) continue;
    const bin = dirname(realExecutable(executable));
    bases.push(bin, ...globalPackages(resolve(bin, '..', 'lib', 'node_modules')));
  }
  for (const base of new Set(bases)) {
    const lib = typescriptLib(base);
    if (lib) return lib;
  }
  return null;
}

/** The version a `lib` from `tsdkLocation` belongs to, from its package; null when unreadable. */
function typescriptVersion(lib: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(lib, '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
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
