import { describe, expect, it } from 'vitest';
import { LANGUAGE_IDS, languageOf } from '@/shared/protocol.js';

describe('languageOf', () => {
  it('takes a YAML or .tpl file under a templates directory for helm', () => {
    for (const path of [
      'deploy/app/templates/deployment.yaml',
      'deploy/app/templates/_helpers.tpl',
      'deploy/app/templates/tests/x.yml',
      'deploy/app/charts/db/templates/svc.yaml',
      'templates/root.YAML',
      // The tradeoff of a rule on the path alone: a templates directory outside any chart counts too.
      'ci/templates/job.yml',
    ])
      expect(languageOf(path), path).toBe('helm');
    expect(languageOf('deploy/app/values.yaml')).toBe('yaml');
    expect(languageOf('deploy/app/Chart.yaml')).toBe('yaml');
    expect(languageOf('deploy/app/my-templates/x.yaml')).toBe('yaml');
    expect(languageOf('deploy/app/templates/NOTES.txt')).toBeNull();
    expect(languageOf('deploy/app/templates/config.json')).toBe('json');
  });

  it('lists helm among the languages a server can be named for', () => {
    expect(LANGUAGE_IDS).toContain('helm');
    expect(LANGUAGE_IDS).toEqual([...LANGUAGE_IDS].sort());
  });
});
