import { describe, expect, it } from 'vitest';
import { LANGUAGE_IDS, languageOf } from '@/shared/protocol.js';

describe('languageOf', () => {
  it("takes a YAML or .tpl file under a chart's templates directory for helm", () => {
    const tree = ['Chart.yaml', 'deploy/app/Chart.yaml', 'deploy/app/charts/db/Chart.yaml'];
    for (const path of [
      'deploy/app/templates/deployment.yaml',
      'deploy/app/templates/_helpers.tpl',
      'deploy/app/templates/tests/x.yml',
      'deploy/app/charts/db/templates/svc.yaml',
      'templates/root.YAML',
    ])
      expect(languageOf(path, tree), path).toBe('helm');
    expect(languageOf('deploy/app/values.yaml', tree)).toBe('yaml');
    expect(languageOf('deploy/app/Chart.yaml', tree)).toBe('yaml');
    expect(languageOf('deploy/app/my-templates/x.yaml', tree)).toBe('yaml');
    // No Chart.yaml beside the templates directory: plain YAML, as in a CI repository.
    expect(languageOf('ci/templates/job.yml', tree)).toBe('yaml');
    expect(languageOf('deploy/app/sub/templates/x.yaml', tree)).toBe('yaml');
    expect(languageOf('deploy/app/templates/NOTES.txt', tree)).toBeNull();
    expect(languageOf('deploy/app/templates/config.json', tree)).toBe('json');
  });

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
      expect(languageOf(path, []), path).toBe('dockerfile');
    }
    for (const path of [
      'Dockerfiles/app.py',
      'my-Dockerfile',
      '.dockerignore',
      'Dockerfile.dockerignore',
      'Dockerfile.dev.dockerignore',
      'Dockerfile/README',
    ]) {
      expect(languageOf(path, []), path).not.toBe('dockerfile');
    }
  });

  it('reads the rest by the last extension, case-insensitively', () => {
    expect(languageOf('src/main.rs', [])).toBe('rust');
    expect(languageOf('App.TSX', [])).toBe('typescriptreact');
    expect(languageOf('a.d.ts', [])).toBe('typescript');
    for (const path of [
      'Makefile',
      'dir.py/Makefile',
      'trailing.',
      'x.unknown',
      '.bashrc',
      'x.constructor',
      'constructor',
    ]) {
      expect(languageOf(path, []), path).toBeNull();
    }
  });

  it('lists named and placed languages beside extended ones', () => {
    expect(LANGUAGE_IDS).toContain('dockerfile');
    expect(LANGUAGE_IDS).toContain('helm');
    expect(LANGUAGE_IDS).toEqual([...new Set(LANGUAGE_IDS)].sort());
  });
});
