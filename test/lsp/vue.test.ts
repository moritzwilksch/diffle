import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializationOptionsFor, settingsFor } from '../../src/server/lsp/configuration.js';
import { vuePluginLocation } from '../../src/server/lsp/vue.js';
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
    expect(initializationOptionsFor('typescript-language-server --stdio', root, found)).toEqual({
      plugins: [{ name: '@vue/typescript-plugin', location, languages: ['vue'] }],
    });
    expect(initializationOptionsFor('typescript-language-server --stdio', root, lookup(null))).toBeUndefined();
    expect(initializationOptionsFor('vtsls --stdio', root, found)).toBeUndefined();
  });

  it('as settings for vtsls', async () => {
    const root = tmp();
    const location = pkg(join(root, 'lib', 'language-tools', 'packages', 'language-server'), '@vue/language-server');
    pkg(join(location, 'node_modules', '@vue', 'typescript-plugin'), '@vue/typescript-plugin', 'index.js');
    const found = lookup(executable(join(root, 'bin', 'vue-language-server')));
    expect(await settingsFor(['typescript', 'vue'], 'vtsls --stdio', found)).toEqual({
      vtsls: {
        tsserver: {
          globalPlugins: [
            { name: '@vue/typescript-plugin', location, languages: ['vue'], configNamespace: 'typescript' },
          ],
        },
      },
    });
    expect(await settingsFor(['typescript'], 'vtsls --stdio', lookup(null))).toEqual({});
    expect(await settingsFor(['typescript'], 'typescript-language-server --stdio', found)).toEqual({});
  });
});
