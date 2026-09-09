import { describe, expect, it } from 'vitest';
import { SKILL } from '../../src/cli/skill.js';

describe('diffle --skill', () => {
  it('names only commands and flags that still exist', () => {
    for (const cmd of ['diffle working', '-C <path>']) expect(SKILL).toContain(cmd);
    for (const mode of ['working', 'pr', 'branch [base]', 'main...feat']) expect(SKILL).toContain(mode);
    // The agent loop is gone: nothing here may teach an agent to write comments.
    for (const gone of ['--comment', '--as', '--background', 'diffle export', 'diffle comment']) expect(SKILL).not.toContain(gone);
  });

  it('describes the prompt the way format.ts renders it', () => {
    expect(SKILL).toContain('ORIGINAL / SUGGESTED');
    expect(SKILL).toContain('(removed)');
    expect(SKILL).toContain('(stale, was line N)');
  });

  it('names read-only routes only', () => {
    for (const route of ['/api/threads?state=', '/api/threads/export']) expect(SKILL).toContain(route);
    for (const route of ['POST /api/threads', '/api/threads/<id>/replies', '/api/threads/<id>/resolved']) expect(SKILL).not.toContain(route);
  });
});
