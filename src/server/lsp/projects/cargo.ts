import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LspSettings } from '@/server/lsp/configuration.js';
import type { ServerContext } from '@/server/lsp/registry.js';
import type { LspProjects } from '@/shared/protocol.js';
import { shownPath } from './shown.js';

const MANIFEST = 'Cargo.toml';
/** A `[workspace]` table header, or a sub-table's (`[workspace.dependencies]`), which declares it too. */
const WORKSPACE = /^[ \t]*\[workspace(\.[^\]]*)?\][ \t]*(#.*)?$/m;

/**
 * The Cargo workspaces behind `paths` (repository-relative), as the absolute manifest
 * paths rust-analyzer takes for `linkedProjects`, sorted. A file's workspace is the
 * nearest manifest declaring `[workspace]` at or above its crate's, else the crate's
 * own. rust-analyzer's discovery stops at the root's manifest, so a separate workspace
 * below it (rattler's `py-rattler`) would go unloaded; naming projects replaces that
 * discovery, so the root's manifest is always named too. Empty when there is none.
 */
export function cargoWorkspaces(root: string, paths: readonly string[]): string[] {
  const found = new Set<string>();
  if (existsSync(join(root, MANIFEST))) found.add(join(root, MANIFEST));
  for (const dir of new Set(paths.map((p) => dirname(p)))) {
    const workspace = workspaceOf(root, dir);
    if (workspace) found.add(workspace);
  }
  return [...found].sort();
}

/** rust-analyzer's `linkedProjects`: every Cargo workspace the diff reaches, when there is one. */
export function linkedProjects({ root, paths }: ServerContext): LspSettings | undefined {
  const projects = cargoWorkspaces(root, paths);
  return projects.length ? { linkedProjects: projects } : undefined;
}

/** The workspaces `linkedProjects` names, for the status. */
export function cargoProjects({ root, paths }: ServerContext): LspProjects {
  return { label: 'Cargo workspaces', paths: cargoWorkspaces(root, paths).map((m) => shownPath(root, m)) };
}

function workspaceOf(root: string, dir: string): string | null {
  let crate: string | null = null;
  for (let d = dir; ; d = dirname(d)) {
    const manifest = join(root, d, MANIFEST);
    if (existsSync(manifest)) {
      crate ??= manifest;
      if (declaresWorkspace(manifest)) return manifest;
    }
    if (d === '.') return crate;
  }
}

function declaresWorkspace(manifest: string): boolean {
  try {
    return WORKSPACE.test(readFileSync(manifest, 'utf8'));
  } catch {
    return false;
  }
}
