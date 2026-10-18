import { describe, expect, it } from 'vitest';
import type { LspServerStatus, LspStatus } from '../../src/shared/protocol.js';
import { hoverOnly, lspBlocker } from '../../src/shared/lsp.js';

const ALL: LspServerStatus['supports'] = [
  'definition',
  'typeDefinition',
  'hover',
  'references',
  'documentSymbol',
  'workspaceSymbol',
  'semanticTokens',
  'documentHighlight',
];
const server = (extra: Partial<LspServerStatus> = {}): LspServerStatus => ({
  name: 'pyrefly',
  command: 'pyrefly lsp',
  state: 'ready',
  languages: ['python'],
  joins: [],
  supports: ALL,
  log: { seq: 0, errors: 0, warnings: 0 },
  ...extra,
});
const status = (...servers: LspServerStatus[]): LspStatus => ({ enabled: true, servers, missing: [] });
const checkout = { newSha: 'worktree', headSha: '' };
const elsewhere = { newSha: 'abc123', headSha: 'def456' };

describe('lspBlocker', () => {
  it('names the run, the snapshot, the language, the server and the feature, in that order', () => {
    const on = status(server());
    expect(lspBlocker({ enabled: false, servers: [], missing: [] }, checkout)).toMatch(/--no-lsp/);
    expect(lspBlocker(on, null)).toMatch(/new side/);
    expect(lspBlocker(on, elsewhere)).toMatch(/new side/);
    expect(lspBlocker(on, checkout, { path: 'notes.txt' })).toBe('No language server for .txt files');
    expect(lspBlocker(on, checkout, { path: 'main.go' })).toBe('No language server runs for go');
    // A program on PATH that lacks what the server loads beside it: installing more is not the answer.
    const broken: LspStatus = {
      ...on,
      missing: [{ language: 'vue', tried: ['vtsls'], why: 'vue-language-server is on PATH but its plugin is not' }],
    };
    expect(lspBlocker(broken, checkout, { path: 'App.vue' })).toBe(
      'No language server for vue: vue-language-server is on PATH but its plugin is not',
    );
    expect(lspBlocker(on, checkout, { path: 'a.py', feature: 'references' })).toBeNull();
    expect(lspBlocker(on, checkout, { feature: 'workspaceSymbol' })).toBeNull();
    const hoverish = status(server({ supports: ['hover'] }));
    expect(lspBlocker(hoverish, checkout, { path: 'a.py', feature: 'definition' })).toBe(
      'pyrefly offers no go to definition',
    );
    expect(lspBlocker(hoverish, checkout, { path: 'a.py', feature: 'hover' })).toBeNull();
  });

  it('lets a starting server through only for a patient caller, and never a dead one', () => {
    const starting = status(server({ state: 'starting', supports: [] }));
    expect(lspBlocker(starting, checkout, { path: 'a.py', feature: 'definition' })).toBe('pyrefly is starting…');
    expect(lspBlocker(starting, checkout, { path: 'a.py', feature: 'definition', patient: true })).toBeNull();
    const dead = status(server({ state: 'unavailable', message: 'exited (1)', supports: [] }));
    expect(lspBlocker(dead, checkout, { path: 'a.py', patient: true })).toBe('pyrefly is unavailable: exited (1)');
  });

  it('counts a server joining the language, after its owner', () => {
    const tailwind = server({
      name: 'tailwind',
      command: 'tailwind',
      languages: [],
      joins: ['css'],
      supports: ['hover'],
    });
    expect(lspBlocker(status(tailwind), checkout, { path: 'a.css', feature: 'hover' })).toBeNull();
    expect(lspBlocker(status(tailwind), checkout, { path: 'a.css', feature: 'definition' })).toBe(
      'tailwind offers no go to definition',
    );
    const starting = server({ name: 'css', command: 'css', state: 'starting', languages: ['css'], supports: [] });
    expect(lspBlocker(status(tailwind, starting), checkout, { path: 'a.css', feature: 'definition' })).toBe(
      'css is starting…',
    );
  });
});

describe('hoverOnly', () => {
  it('is true for a file whose ready servers navigate nowhere, such as a schema server', () => {
    expect(hoverOnly(status(server({ languages: ['json'], supports: ['hover', 'documentSymbol'] })), 'x.json')).toBe(
      true,
    );
    expect(hoverOnly(status(server()), 'a.py')).toBe(false);
    expect(hoverOnly(status(server({ state: 'starting', supports: [] })), 'a.py')).toBe(false);
    expect(hoverOnly(status(), 'a.py')).toBe(false);
  });
});
