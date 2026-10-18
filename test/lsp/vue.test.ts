import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { definitionOf } from '@/server/lsp/registry.js';
import { vuePluginLocation } from '@/server/lsp/vue.js';
import { rmTmp } from '../tmp.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(rmTmp));
});

function tmp(): string {
  // Canonical, so a location reached through a symlink compares equal to the one laid out.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diffle-vue-')));
  dirs.push(dir);
  return dir;
}

/** A package directory with a package.json, optionally with its own `main` module. */
function pkg(dir: string, name: string, main?: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '3.0.0', main }));
  if (main) writeFileSync(join(dir, main), 'module.exports = () => ({});\n');
  return dir;
}

function executable(at: string): string {
  mkdirSync(join(at, '..'), { recursive: true });
  writeFileSync(at, '#!/bin/sh\nexit 0\n');
  chmodSync(at, 0o755);
  return at;
}

/**
 * The npm global layout: `bin/vue-language-server` links into the package, and the
 * plugin is hoisted beside it under `lib/node_modules`.
 */
function npmLayout(root: string): { executable: string; location: string } {
  const modules = join(root, 'lib', 'node_modules');
  const location = pkg(join(modules, '@vue', 'language-server'), '@vue/language-server');
  pkg(join(modules, '@vue', 'typescript-plugin'), '@vue/typescript-plugin', 'index.js');
  mkdirSync(join(location, 'bin'));
  writeFileSync(join(location, 'bin', 'vue-language-server.js'), '#!/usr/bin/env node\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync(
    join('..', 'lib', 'node_modules', '@vue', 'language-server', 'bin', 'vue-language-server.js'),
    join(bin, 'vue-language-server'),
  );
  return { executable: join(bin, 'vue-language-server'), location };
}

describe('vuePluginLocation', () => {
  // Windows: creating a symlink needs a privilege the CI runner lacks.
  it.skipIf(process.platform === 'win32')('follows the npm symlink into the package', () => {
    const { executable, location } = npmLayout(tmp());
    expect(vuePluginLocation(executable)).toBe(location);
  });

  it('finds the package beside a Windows shim', () => {
    const bin = tmp();
    const location = pkg(join(bin, 'node_modules', '@vue', 'language-server'), '@vue/language-server');
    pkg(join(location, 'node_modules', '@vue', 'typescript-plugin'), '@vue/typescript-plugin', 'index.js');
    writeFileSync(
      join(bin, 'vue-language-server.cmd'),
      '@node "%~dp0\\node_modules\\@vue\\language-server\\bin\\vue-language-server.js" %*\n',
    );
    expect(vuePluginLocation(join(bin, 'vue-language-server.cmd'))).toBe(location);
  });

  it('finds the nixpkgs monorepo beside its wrapper', () => {
    const root = tmp();
    const location = pkg(join(root, 'lib', 'language-tools', 'packages', 'language-server'), '@vue/language-server');
    pkg(join(location, 'node_modules', '@vue', 'typescript-plugin'), '@vue/typescript-plugin', 'index.js');
    expect(vuePluginLocation(executable(join(root, 'bin', 'vue-language-server')))).toBe(location);
  });

  /**
   * A conda environment: a launcher script in `bin` beside `lib/node_modules`, where the
   * plugin is nested under the language-server package.
   */
  function condaLayout(prefix: string): { executable: string; location: string } {
    const location = pkg(join(prefix, 'lib', 'node_modules', '@vue', 'language-server'), '@vue/language-server');
    pkg(join(location, 'node_modules', '@vue', 'typescript-plugin'), '@vue/typescript-plugin', 'index.js');
    return { executable: executable(join(prefix, 'bin', 'vue-language-server')), location };
  }

  it('finds the package beside a conda launcher', () => {
    const { executable, location } = condaLayout(tmp());
    expect(vuePluginLocation(executable)).toBe(location);
  });

  it('follows a pixi global trampoline into its environment', () => {
    const root = tmp();
    const env = condaLayout(join(root, 'envs', 'vue-language-server'));
    // The file on PATH is a native launcher; its configuration beside it names the real program.
    const trampoline = executable(join(root, 'bin', 'vue-language-server'));
    mkdirSync(join(root, 'bin', 'trampoline_configuration'));
    writeFileSync(
      join(root, 'bin', 'trampoline_configuration', 'vue-language-server.json'),
      JSON.stringify({ exe: env.executable, path_diff: join(root, 'envs', 'vue-language-server', 'bin') }),
    );
    expect(vuePluginLocation(trampoline)).toBe(env.location);
    // A configuration naming nothing usable is ignored.
    writeFileSync(join(root, 'bin', 'trampoline_configuration', 'vue-language-server.json'), '{"exe": 1}');
    expect(vuePluginLocation(trampoline)).toBeNull();
  });

  it('gives up on a layout without the plugin', () => {
    const root = tmp();
    pkg(join(root, 'lib', 'language-tools', 'packages', 'language-server'), '@vue/language-server');
    expect(vuePluginLocation(executable(join(root, 'bin', 'vue-language-server')))).toBeNull();
    expect(vuePluginLocation(join(root, 'bin', 'missing'))).toBeNull();
  });
});

describe('TypeScript servers load the plugin', () => {
  const lookup = (location: string | null) => (command: string) =>
    command === 'vue-language-server' ? location : null;

  it('as initializationOptions for typescript-language-server', () => {
    const root = tmp();
    const location = pkg(join(root, 'lib', 'language-tools', 'packages', 'language-server'), '@vue/language-server');
    pkg(join(location, 'node_modules', '@vue', 'typescript-plugin'), '@vue/typescript-plugin', 'index.js');
    const found = lookup(executable(join(root, 'bin', 'vue-language-server')));
    expect(definitionOf('typescript-language-server --stdio').initializationOptions?.({ root, lookup: found })).toEqual(
      {
        plugins: [{ name: '@vue/typescript-plugin', location, languages: ['vue'] }],
      },
    );
    expect(
      definitionOf('typescript-language-server --stdio').initializationOptions?.({ root, lookup: lookup(null) }),
    ).toBeUndefined();
    expect(definitionOf('vtsls --stdio').initializationOptions?.({ root, lookup: found })).toBeUndefined();
  });

  it('as settings for vtsls', async () => {
    const root = tmp();
    const location = pkg(join(root, 'lib', 'language-tools', 'packages', 'language-server'), '@vue/language-server');
    pkg(join(location, 'node_modules', '@vue', 'typescript-plugin'), '@vue/typescript-plugin', 'index.js');
    const found = lookup(executable(join(root, 'bin', 'vue-language-server')));
    expect(await definitionOf('vtsls --stdio').settings?.({ root, lookup: found })).toEqual({
      vtsls: {
        tsserver: {
          globalPlugins: [
            { name: '@vue/typescript-plugin', location, languages: ['vue'], configNamespace: 'typescript' },
          ],
        },
      },
    });
    expect(await definitionOf('vtsls --stdio').settings?.({ root, lookup: lookup(null) })).toEqual({});
    expect(definitionOf('typescript-language-server --stdio').settings).toBeUndefined();
  });
});
