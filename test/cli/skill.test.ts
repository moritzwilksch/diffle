import { describe, expect, it } from 'vitest';
import { commentCommand } from '../../src/cli/comment.js';
import { parseImports } from '../../src/server/comments/import.js';
import { SKILL } from '../../src/cli/skill.js';

describe('diffle --skill', () => {
  it('names every comment subcommand and the flags it teaches, and its payload example parses', () => {
    const subcommands = commentCommand().commands.map((c) => c.name());
    expect(subcommands.sort()).toEqual(['add', 'get', 'reply', 'resolve']);
    for (const sub of subcommands) expect(SKILL).toContain(`comment ${sub}`);
    expect(SKILL).toContain('diffle export');
    for (const flag of ['--comment', '--as', '--background', '--format json', '--state all', '-C <path>', '@-', '--url']) expect(SKILL).toContain(flag);
    const example = /^ {4}(\[\{.*\}\])$/m.exec(SKILL);
    expect(example).not.toBeNull();
    expect(parseImports(example![1]!)).toEqual([{ path: 'src/app.py', startLine: 42, endLine: 44, body: 'Batch this instead of looping.' }]);
    // Prompt anatomy matches format.ts.
    expect(SKILL).toContain('ORIGINAL / SUGGESTED');
    expect(SKILL).toContain('"you:"');
    expect(SKILL).toContain('agent (<name>):');
    // Every HTTP route the fallback section names is served.
    for (const route of ['/api/threads?state=', '/api/threads/export', '/api/threads/<id>/replies', '/api/threads/<id>/resolved']) expect(SKILL).toContain(route);
  });
});
