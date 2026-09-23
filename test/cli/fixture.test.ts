import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { rmTmp } from '../tmp.js';

const TSX = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const SCRIPT = join(process.cwd(), 'scripts/fixture-repo.ts');

it('rejects a nonempty destination with exit 2 and preserves its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diffle-fixture-cli-'));
  try {
    await writeFile(join(dir, 'keep.txt'), 'uncommitted work\n');
    const result = spawnSync(process.execPath, [TSX, SCRIPT, '.'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Refusing to overwrite nonempty directory:');
    expect(await readFile(join(dir, 'keep.txt'), 'utf8')).toBe('uncommitted work\n');
  } finally {
    await rmTmp(dir);
  }
});

it('creates a different temporary repository on each invocation without a destination', async () => {
  const dirs: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [TSX, SCRIPT], { encoding: 'utf8' });
      const dir = /^Fixture repository built at (.+)$/m.exec(result.stdout)?.[1];
      if (dir) dirs.push(dir);
      expect(result.status, result.stderr).toBe(0);
      expect(dir).toBeDefined();
    }
    expect(dirs[0]).not.toBe(dirs[1]);
    for (const dir of dirs) expect(await readFile(join(dir, '.git/HEAD'), 'utf8')).toContain('feature/refunds');
  } finally {
    await Promise.all(dirs.map(rmTmp));
  }
}, 30_000);
