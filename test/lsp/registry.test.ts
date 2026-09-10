import { describe, expect, it } from 'vitest';
import { candidatesFor, CANDIDATES, resolveServers } from '../../src/server/lsp/registry.js';
import { LANGUAGE_IDS, languageOf } from '../../src/shared/protocol.js';

/** A PATH holding exactly `programs`. */
const path =
  (...programs: string[]) =>
  (command: string) =>
    programs.includes(command.split(' ')[0]!) ? `/usr/bin/${command.split(' ')[0]}` : null;

describe('resolveServers', () => {
  it('routes config files and prefers Tombi, with Taplo as the fallback', () => {
    expect(['package.json', 'settings.jsonc', 'ci.yaml', 'ci.yml', 'Cargo.toml'].map(languageOf)).toEqual([
      'json',
      'jsonc',
      'yaml',
      'yaml',
      'toml',
    ]);
    expect(resolveServers(['toml'], {}, path('tombi', 'taplo')).servers).toEqual([
      { command: 'tombi lsp', languages: ['toml'] },
    ]);
    expect(resolveServers(['toml'], {}, path('taplo')).servers).toEqual([
      { command: 'taplo lsp stdio', languages: ['toml'] },
    ]);
    expect(
      resolveServers(['json', 'jsonc', 'yaml'], {}, path('vscode-json-language-server', 'yaml-language-server'))
        .servers,
    ).toEqual([
      { command: 'vscode-json-language-server --stdio', languages: ['json', 'jsonc'] },
      { command: 'yaml-language-server --stdio', languages: ['yaml'] },
    ]);
  });

  it('takes the first candidate on PATH and names the rest as missing', () => {
    const { servers, missing } = resolveServers(['python', 'go'], {}, path('pylsp', 'jedi-language-server'));
    expect(servers).toEqual([{ command: 'pylsp', languages: ['python'] }]);
    expect(missing).toEqual([{ language: 'go', tried: ['gopls'] }]);
  });

  it('groups languages that share a command into one server', () => {
    const { servers } = resolveServers(['cpp', 'c', 'typescript', 'javascript'], {}, path('clangd', 'vtsls'));
    expect(servers).toEqual([
      { command: 'clangd', languages: ['c', 'cpp'] },
      { command: 'vtsls --stdio', languages: ['javascript', 'typescript'] },
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
    expect(servers).toEqual([{ command: 'my-server --stdio', languages: ['python'] }]);
    // An off language names nothing to install; a language with no server on PATH does.
    expect(missing).toEqual([
      { language: 'go', tried: ['gopls'] },
      { language: 'rust', tried: [] },
    ]);
    expect(probed).toEqual(candidatesFor('go'));
  });

  it('probes each candidate once, however many languages ask for it', () => {
    const probed: string[] = [];
    resolveServers(['typescript', 'typescriptreact', 'javascript', 'javascriptreact'], {}, (c) => {
      probed.push(c);
      return null;
    });
    expect(probed).toEqual([...new Set(probed)]);
  });

  it('knows a server for every language it recognizes', () => {
    for (const language of LANGUAGE_IDS) expect(candidatesFor(language).length).toBeGreaterThan(0);
    // Candidate commands are plain `prog arg…` lines, so their first word is a program to probe.
    for (const { command } of CANDIDATES) expect(command).toMatch(/^[\w.-]+( [-\w.=/]+)*$/);
  });
});
