import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shownPath } from '@/server/lsp/projects/shown.js';

describe('shownPath', () => {
  const root = join(homedir(), 'src', 'app');
  it('reads repository-relative inside the repository, with forward slashes', () => {
    expect(shownPath(root, join(root, 'frontend', 'node_modules', 'typescript'))).toBe(
      'frontend/node_modules/typescript',
    );
    expect(shownPath(root, root)).toBe('.');
    // A sibling whose name starts with dots is outside, not a parent.
    expect(shownPath(root, join(root, '..', 'app..x'))).toBe('~/src/app..x');
  });

  it('abbreviates the home directory, and leaves anything else absolute', () => {
    expect(shownPath(root, join(homedir(), '.local', 'lib', 'node_modules', 'typescript'))).toBe(
      '~/.local/lib/node_modules/typescript',
    );
    const elsewhere = join(homedir(), '..', 'opt-elsewhere', 'typescript');
    expect(shownPath(root, elsewhere)).toBe(join(elsewhere));
  });
});
