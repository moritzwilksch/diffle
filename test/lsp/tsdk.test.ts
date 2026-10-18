import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definitionOf } from '../../src/server/lsp/registry.js';
import { tsdkLocation } from '../../src/server/lsp/tsdk.js';
import { rmTmp } from '../tmp.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(rmTmp));
});

function tmp(): string {
  // Canonical, so a location reached through a symlink compares equal to the one laid out.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diffle-tsdk-')));
  dirs.push(dir);
  return dir;
}

/** A `typescript` package under `modules`; TypeScript 7 ships no `lib/typescript.js`. Returns its lib. */
function typescript(modules: string, version = '6.0.3'): string {
  const dir = join(modules, 'typescript');
  const lib = join(dir, 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version }));
  writeFileSync(join(lib, version.startsWith('7') ? 'tsc.js' : 'typescript.js'), '');
  return lib;
}

function executable(at: string): string {
  mkdirSync(join(at, '..'), { recursive: true });
  writeFileSync(at, '#!/bin/sh\nexit 0\n');
  chmodSync(at, 0o755);
  return at;
}

describe('tsdkLocation', () => {
  it('prefers the repository’s TypeScript to the server’s', () => {
    const root = tmp();
    const repo = typescript(join(root, 'repo', 'node_modules'));
    const bin = join(root, 'bin');
    typescript(join(bin, 'node_modules'));
    expect(tsdkLocation(join(root, 'repo'), [executable(join(bin, 'astro-ls'))])).toBe(repo);
  });

  // Windows: creating a symlink needs a privilege the CI runner lacks.
  it.skipIf(process.platform === 'win32')(
    'follows the npm symlink to the TypeScript hoisted beside the package',
    () => {
      const root = tmp();
      const modules = join(root, 'lib', 'node_modules');
      const server = join(modules, '@astrojs', 'language-server', 'bin');
      mkdirSync(server, { recursive: true });
      writeFileSync(join(server, 'nodeServer.js'), '');
      const lib = typescript(modules);
      mkdirSync(join(root, 'bin'));
      symlinkSync(
        join('..', 'lib', 'node_modules', '@astrojs', 'language-server', 'bin', 'nodeServer.js'),
        join(root, 'bin', 'astro-ls'),
      );
      expect(tsdkLocation(join(root, 'repo'), [join(root, 'bin', 'astro-ls')])).toBe(lib);
    },
  );

  it('finds the TypeScript beside a Windows shim', () => {
    const bin = tmp();
    const lib = typescript(join(bin, 'node_modules'));
    writeFileSync(
      join(bin, 'astro-ls.cmd'),
      '@node "%~dp0\\node_modules\\@astrojs\\language-server\\bin\\nodeServer.js" %*\n',
    );
    expect(tsdkLocation(join(bin, 'repo'), [join(bin, 'astro-ls.cmd')])).toBe(lib);
  });

  it.skipIf(process.platform === 'win32')('reaches through the pnpm store nixpkgs lays out', () => {
    const root = tmp();
    const pkg = join(
      root,
      'lib',
      'node_modules',
      'astro-language-server',
      'packages',
      'language-tools',
      'language-server',
    );
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'bin', 'nodeServer.js'), '');
    const lib = typescript(
      join(
        root,
        'lib',
        'node_modules',
        'astro-language-server',
        'node_modules',
        '.pnpm',
        'typescript@6.0.3',
        'node_modules',
      ),
    );
    mkdirSync(join(pkg, 'node_modules'));
    symlinkSync(join(lib, '..'), join(pkg, 'node_modules', 'typescript'));
    mkdirSync(join(root, 'bin'));
    symlinkSync(join(pkg, 'bin', 'nodeServer.js'), join(root, 'bin', 'astro-ls'));
    expect(tsdkLocation(join(root, 'repo'), [join(root, 'bin', 'astro-ls')])).toBe(lib);
  });

  it('reaches a conda environment’s packages through a pixi trampoline', () => {
    const root = tmp();
    const prefix = join(root, 'envs', 'astro-ls');
    const launcher = executable(join(prefix, 'bin', 'astro-ls'));
    const trampoline = executable(join(root, 'bin', 'astro-ls'));
    mkdirSync(join(root, 'bin', 'trampoline_configuration'));
    writeFileSync(join(root, 'bin', 'trampoline_configuration', 'astro-ls.json'), JSON.stringify({ exe: launcher }));
    // Nested under the server package, as the conda package lays it out.
    const nested = typescript(join(prefix, 'lib', 'node_modules', '@astrojs', 'language-server', 'node_modules'));
    expect(tsdkLocation(join(root, 'repo'), [trampoline])).toBe(nested);
    // A TypeScript 7 there is passed over for one hoisted beside the package.
    const other = join(root, 'envs', 'other');
    typescript(join(other, 'lib', 'node_modules', '@astrojs', 'language-server', 'node_modules'), '7.0.2');
    const hoisted = typescript(join(other, 'lib', 'node_modules'));
    expect(tsdkLocation(join(root, 'repo'), [executable(join(other, 'bin', 'astro-ls'))])).toBe(hoisted);
  });

  it('passes over TypeScript 7 and over nothing at all', () => {
    const root = tmp();
    typescript(join(root, 'repo', 'node_modules'), '7.0.2');
    const bin = join(root, 'bin');
    typescript(join(bin, 'node_modules'), '7.0.2');
    expect(
      tsdkLocation(join(root, 'repo'), [executable(join(bin, 'astro-ls')), null, join(bin, 'missing')]),
    ).toBeNull();
    const other = typescript(join(bin, 'other', 'node_modules'));
    expect(
      tsdkLocation(join(root, 'repo'), [executable(join(bin, 'astro-ls')), executable(join(bin, 'other', 'vtsls'))]),
    ).toBe(other);
  });
});

describe('astro-ls takes its TypeScript at initialize', () => {
  it('from the repository, else from beside a server on PATH', () => {
    const root = tmp();
    const bin = join(root, 'bin');
    const lib = typescript(join(bin, 'node_modules'));
    const found = (programs: string[]) => (command: string) => {
      const program = command.split(' ')[0]!;
      return programs.includes(program) ? executable(join(bin, program)) : null;
    };
    expect(
      definitionOf('astro-ls --stdio').initializationOptions?.({
        root: join(root, 'repo'),
        lookup: found(['astro-ls']),
      }),
    ).toEqual({
      typescript: { tsdk: lib },
    });
    // astro-ls on PATH beside no TypeScript, but a TypeScript server beside one elsewhere.
    const elsewhere = typescript(join(root, 'elsewhere', 'node_modules'));
    const lookup = (command: string) =>
      command.startsWith('astro-ls')
        ? executable(join(root, 'bare', 'astro-ls'))
        : command.startsWith('vtsls')
          ? executable(join(root, 'elsewhere', 'vtsls'))
          : null;
    expect(definitionOf('astro-ls --stdio').initializationOptions?.({ root: join(root, 'repo'), lookup })).toEqual({
      typescript: { tsdk: elsewhere },
    });
    expect(
      definitionOf('astro-ls --stdio').initializationOptions?.({ root: join(root, 'repo'), lookup: () => null }),
    ).toBeUndefined();
    expect(definitionOf('vtsls --stdio').initializationOptions).toBeUndefined();
  });
});
