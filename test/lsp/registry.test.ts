import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { candidatesFor, CANDIDATES, definitionOf, resolveServers } from '@/server/lsp/registry.js';
import { LANGUAGE_IDS } from '@/shared/protocol.js';
import { rmTmp } from '../tmp.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(rmTmp));
});

/** A `vue-language-server` laid out as nixpkgs does, with the tsserver plugin beside it. */
function vueLanguageServer(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'diffle-registry-')));
  dirs.push(root);
  const plugin = join(root, 'lib', 'language-tools', 'packages', 'language-server', 'node_modules', '@vue');
  mkdirSync(join(plugin, 'typescript-plugin'), { recursive: true });
  writeFileSync(join(plugin, 'typescript-plugin', 'package.json'), '{"name":"@vue/typescript-plugin","main":"i.js"}');
  writeFileSync(join(plugin, 'typescript-plugin', 'i.js'), '');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'vue-language-server'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'bin', 'vue-language-server'), 0o755);
  return join(root, 'bin', 'vue-language-server');
}

/** A PATH holding exactly `programs`. */
const path =
  (...programs: string[]) =>
  (command: string) =>
    programs.includes(command.split(' ')[0]!) ? `/usr/bin/${command.split(' ')[0]}` : null;

describe('resolveServers', () => {
  it('takes the first candidate on PATH and names the rest as missing', () => {
    const { servers, missing } = resolveServers(['python', 'go'], {}, path('pylsp', 'jedi-language-server'));
    expect(servers).toEqual([{ command: 'pylsp', languages: ['python'], joins: [] }]);
    expect(missing).toEqual([{ language: 'go', tried: ['gopls'] }]);
  });

  it('groups languages that share a command into one server', () => {
    const { servers } = resolveServers(['cpp', 'c', 'typescript', 'javascript'], {}, path('clangd', 'vtsls'));
    expect(servers).toEqual([
      { command: 'clangd', languages: ['c', 'cpp'], joins: [] },
      { command: 'vtsls --stdio', languages: ['javascript', 'typescript'], joins: [] },
    ]);
  });

  it('sorts languages, so two runs of the same diff resolve the same way', () => {
    const lookup = path('gopls', 'rust-analyzer', 'zls');
    const one = resolveServers(['zig', 'rust', 'go'], {}, lookup);
    const two = resolveServers(['go', 'zig', 'rust'], {}, lookup);
    expect(one).toEqual(two);
    expect(one.servers.map((s) => s.command)).toEqual(['gopls', 'rust-analyzer', 'zls']);
  });

  it('uses an override without probing it, and reads an empty one as off', () => {
    const probed: string[] = [];
    const { servers, missing } = resolveServers(
      ['python', 'rust', 'go'],
      { python: '  my-server --stdio  ', rust: '' },
      (c) => {
        probed.push(c);
        return null;
      },
    );
    expect(servers).toEqual([{ command: 'my-server --stdio', languages: ['python'], joins: [] }]);
    // An off language names nothing to install; a language with no server on PATH does.
    expect(missing).toEqual([
      { language: 'go', tried: ['gopls'] },
      { language: 'rust', tried: [] },
    ]);
    expect(probed).toEqual(candidatesFor('go'));
  });

  it('routes vue to a TypeScript server only beside the plugin vue-language-server ships', () => {
    // Nothing installed: every program a candidate would need, in candidate order.
    expect(resolveServers(['vue'], {}, path()).missing).toEqual([
      { language: 'vue', tried: ['typescript-language-server', 'vue-language-server', 'vtsls'] },
    ]);
    // The TypeScript server alone names what is still to install, not what is already there.
    expect(resolveServers(['vue'], {}, path('typescript-language-server')).missing).toEqual([
      { language: 'vue', tried: ['vue-language-server', 'vtsls'] },
    ]);
    // On PATH, but with nothing beside it tsserver could load: as good as absent, and said so.
    const bare = resolveServers(['vue', 'typescript'], {}, path('typescript-language-server', 'vue-language-server'));
    expect(bare.servers).toEqual([
      { command: 'typescript-language-server --stdio', languages: ['typescript'], joins: [] },
    ]);
    expect(bare.missing).toEqual([
      {
        language: 'vue',
        tried: ['vtsls'],
        why: 'vue-language-server is on PATH but @vue/typescript-plugin was not found beside it',
      },
    ]);
    const installed = vueLanguageServer();
    const { servers, missing } = resolveServers(['vue', 'typescript'], {}, (command) =>
      command.startsWith('vue-language-server') ? installed : path('typescript-language-server')(command),
    );
    expect(servers).toEqual([
      { command: 'typescript-language-server --stdio', languages: ['typescript', 'vue'], joins: [] },
    ]);
    expect(missing).toEqual([]);
  });

  it('starts a joining server for any language it joins, whatever owns it, joining only the asked ones', () => {
    const tailwind = 'tailwindcss-language-server --stdio';
    const both = resolveServers(['typescriptreact', 'python'], {}, path('vtsls', 'tailwindcss-language-server'));
    expect(both.servers).toEqual([
      { command: 'vtsls --stdio', languages: ['typescriptreact'], joins: [] },
      { command: tailwind, languages: [], joins: ['typescriptreact'] },
    ]);
    // Python is not joined, so it is missing as before; an absent joiner is nobody's missing server.
    expect(both.missing).toEqual([{ language: 'python', tried: candidatesFor('python').map((c) => c.split(' ')[0]) }]);
    expect(resolveServers(['python'], {}, path('tailwindcss-language-server')).servers).toEqual([]);
    const alone = resolveServers(['css'], {}, path('tailwindcss-language-server'));
    expect(alone.servers.map((s) => s.command)).toEqual([tailwind]);
    expect(alone.missing).toEqual([{ language: 'css', tried: ['vscode-css-language-server'] }]);
    expect(resolveServers(['css'], {}, path()).servers).toEqual([]);
  });

  it('probes each candidate once, however many languages ask for it', () => {
    const probed: string[] = [];
    resolveServers(['typescript', 'typescriptreact', 'javascript', 'javascriptreact'], {}, (c) => {
      probed.push(c);
      return null;
    });
    expect(probed).toEqual([...new Set(probed)]);
  });

  it('configures a command by its program, however it is spelled, and an unknown one not at all', async () => {
    const ctx = { root: '/repo', paths: [], lookup: () => null };
    expect(definitionOf('tombi lsp').settings).toBeUndefined();
    // The VS Code CSS server's linter crashes on a null `lint` section, and nobody reads its diagnostics.
    expect(await definitionOf('vscode-css-language-server --stdio').settings?.(ctx)).toEqual({
      css: { validate: false },
      less: { validate: false },
      scss: { validate: false },
    });
    expect(await definitionOf('"C:\\tools\\taplo.exe" lsp stdio').settings?.(ctx)).toHaveProperty(
      'evenBetterToml.schema.enabled',
      true,
    );
    expect(definitionOf('my-server --stdio')).toEqual({ command: 'my-server --stdio' });
  });

  it('knows a server for every language it recognizes', () => {
    for (const language of LANGUAGE_IDS) expect(candidatesFor(language).length).toBeGreaterThan(0);
    // Candidate commands are plain `prog arg…` lines, so their first word is a program to probe.
    for (const { command } of CANDIDATES) expect(command).toMatch(/^[\w.-]+( [-\w.=/]+)*$/);
  });
});
