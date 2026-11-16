import { describe, expect, it } from 'vitest';
import { LANGUAGE_IDS, languageOf } from '@/shared/protocol.js';

describe('languageOf', () => {
  const tree = [
    'Chart.yaml',
    'deploy/app/Chart.yaml',
    'deploy/app/charts/db/Chart.yaml',
    'deploy/app/templates/deployment.yaml',
    'deploy/app/values.yaml',
    'ci/templates/job.yml',
    'MyChart.yaml',
  ];

  it('takes a template for helm only under a chart the same side holds', () => {
    const of = (path: string) => languageOf(path, tree);
    expect(of('deploy/app/templates/deployment.yaml')).toBe('helm');
    expect(of('deploy/app/templates/_helpers.tpl')).toBe('helm');
    expect(of('deploy/app/templates/tests/test-connection.YML')).toBe('helm');
    expect(of('deploy/app/charts/db/templates/svc.yaml')).toBe('helm');
    expect(of('templates/root.yaml')).toBe('helm');
    // The chart's own files, other YAML, and a template outside any chart stay what they were.
    expect(of('deploy/app/values.yaml')).toBe('yaml');
    expect(of('deploy/app/Chart.yaml')).toBe('yaml');
    expect(of('deploy/app/templates/NOTES.txt')).toBeNull();
    expect(of('ci/templates/job.yml')).toBe('yaml');
    expect(of('ci/templates/macro.tpl')).toBeNull();
    expect(of('deploy/app/my-templates/x.yaml')).toBe('yaml');
    // Without a `Chart.yaml` on this side, the same path is plain YAML.
    expect(languageOf('deploy/app/templates/deployment.yaml', [])).toBe('yaml');
  });

  it('lists helm among the languages a server can be named for', () => {
    expect(LANGUAGE_IDS).toContain('helm');
    expect(LANGUAGE_IDS).toEqual([...LANGUAGE_IDS].sort());
  });
});
