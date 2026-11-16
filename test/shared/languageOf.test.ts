import { describe, expect, it } from 'vitest';
import { LANGUAGE_IDS, languageOf } from '@/shared/protocol.js';

describe('languageOf', () => {
  it('reads Dockerfiles by name before the extension', () => {
    for (const path of [
      'Dockerfile',
      'container/Dockerfile',
      'Containerfile',
      'Dockerfile.dev',
      'api.dockerfile',
      'api.containerfile',
      'c:\\x\\dockerfile',
    ]) {
      expect(languageOf(path), path).toBe('dockerfile');
    }
    for (const path of [
      'Dockerfiles/app.py',
      'my-Dockerfile',
      '.dockerignore',
      'Dockerfile.dockerignore',
      'Dockerfile.dev.dockerignore',
      'Dockerfile/README',
    ]) {
      expect(languageOf(path), path).not.toBe('dockerfile');
    }
  });

  it('reads the rest by the last extension, case-insensitively', () => {
    expect(languageOf('src/main.rs')).toBe('rust');
    expect(languageOf('App.TSX')).toBe('typescriptreact');
    expect(languageOf('a.d.ts')).toBe('typescript');
    for (const path of [
      'Makefile',
      'dir.py/Makefile',
      'trailing.',
      'x.unknown',
      '.bashrc',
      'x.constructor',
      'constructor',
    ]) {
      expect(languageOf(path), path).toBeNull();
    }
  });

  it('lists named languages beside extended ones', () => {
    expect(LANGUAGE_IDS).toContain('dockerfile');
    expect(LANGUAGE_IDS).toEqual([...new Set(LANGUAGE_IDS)].sort());
  });
});
