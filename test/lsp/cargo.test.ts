import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cargoWorkspaces } from '@/server/lsp/projects/cargo.js';
import { definitionOf } from '@/server/lsp/registry.js';
import { rmTmp } from '../tmp.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(rmTmp));
});

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** conda/rattler's layout: a root workspace over `crates/*`, and bindings that are workspaces of their own. */
function rattler(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'diffle-cargo-')));
  dirs.push(root);
  write(root, 'Cargo.toml', '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n');
  write(root, 'crates/rattler/Cargo.toml', '[package]\nname = "rattler"\n');
  write(root, 'py-rattler/Cargo.toml', '[package]\nname = "py-rattler"\n\n# Not in the root workspace\n[workspace]\n');
  write(root, 'js-rattler/Cargo.toml', '[package]\nname = "js-rattler"\n\n[workspace] # its own\n');
  return root;
}

describe('cargoWorkspaces', () => {
  it('names the workspace behind each file, and the root’s always', () => {
    const root = rattler();
    expect(cargoWorkspaces(root, ['crates/rattler/src/lib.rs', 'crates/rattler/src/install/mod.rs'])).toEqual([
      join(root, 'Cargo.toml'),
    ]);
    expect(
      cargoWorkspaces(root, ['py-rattler/src/lib.rs', 'js-rattler/src/lib.rs', 'crates/rattler/build.rs']),
    ).toEqual([join(root, 'Cargo.toml'), join(root, 'js-rattler/Cargo.toml'), join(root, 'py-rattler/Cargo.toml')]);
    expect(cargoWorkspaces(root, [])).toEqual([join(root, 'Cargo.toml')]);
  });

  it('takes the crate itself when no manifest above it declares a workspace', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'diffle-cargo-')));
    dirs.push(root);
    expect(cargoWorkspaces(root, ['tool/src/main.rs'])).toEqual([]);
    write(root, 'tool/Cargo.toml', '[package]\nname = "tool"\n');
    // A workspace sub-table declares the workspace as well; a key merely named like one does not.
    write(root, 'other/Cargo.toml', '[workspace.dependencies]\nserde = "1"\n');
    write(root, 'other/member/Cargo.toml', '[package]\nname = "member"\nworkspace_note = "[workspace]"\n');
    expect(cargoWorkspaces(root, ['tool/src/main.rs', 'other/member/src/lib.rs'])).toEqual([
      join(root, 'other/Cargo.toml'),
      join(root, 'tool/Cargo.toml'),
    ]);
  });

  it('reach rust-analyzer as linkedProjects, at initialize and in its settings', async () => {
    const root = rattler();
    const ctx = { root, paths: ['py-rattler/src/lib.rs'], lookup: () => null };
    const linkedProjects = [join(root, 'Cargo.toml'), join(root, 'py-rattler/Cargo.toml')];
    const definition = definitionOf('rust-analyzer');
    expect(definition.initializationOptions?.(ctx)).toEqual({ linkedProjects });
    expect(await definition.settings?.(ctx)).toEqual({ 'rust-analyzer': { linkedProjects } });
    expect(definition.reconfigures).toBe(true);
    expect(definition.projects?.(ctx)).toEqual({
      label: 'Cargo workspaces',
      paths: ['Cargo.toml', 'py-rattler/Cargo.toml'],
    });
    const bare = { root: join(root, 'crates'), paths: [], lookup: () => null };
    expect(definition.initializationOptions?.(bare)).toBeUndefined();
    expect(await definition.settings?.(bare)).toEqual({});
    expect(definition.projects?.(bare)).toEqual({ label: 'Cargo workspaces', paths: [] });
  });
});
