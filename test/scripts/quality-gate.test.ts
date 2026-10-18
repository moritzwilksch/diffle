import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGate } from '../../scripts/lib/quality-gate/run.js';
import { rmTmp } from '../tmp.js';

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n') + '\n';
const stubs = (count: number, dir: string) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${dir}/m${i}.ts`, `export const v${i} = ${i};\n`]));
const clean = { exitCode: 0, output: '' };

/** A repository with `files` committed, and helpers to change it and run the gate inside it. */
async function repo(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'diffle-gate-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const write = async (changes: Record<string, string>) => {
    for (const [path, content] of Object.entries(changes)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
  };
  git('init', '-q', '--template=');
  git('config', 'user.name', 'Gate test');
  git('config', 'user.email', 'gate@example.com');
  await write({ 'README.md': 'readme\n', ...files });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, git, write, gate: () => runGate(dir) };
}

async function withRepo(files: Record<string, string>, body: (r: Awaited<ReturnType<typeof repo>>) => Promise<void>) {
  const r = await repo(files);
  try {
    await body(r);
  } finally {
    await rmTmp(r.dir);
  }
}

describe('size guard', () => {
  it('lets a file at the cap through and blocks one line more', async () => {
    await withRepo({ 'src/edge.ts': lines(330) }, async ({ write, gate }) => {
      expect(gate()).toEqual(clean);
      await write({ 'src/edge.ts': lines(331) });
      const result = gate();
      expect(result.exitCode).toBe(1);
      await expect(result.output).toMatchFileSnapshot('__snapshots__/quality-gate-size.txt');
    });
  });

  it('judges the whole tree: committed, unstaged and untracked files, with nothing staged', async () => {
    await withRepo({ 'src/legacy.ts': lines(400) }, async ({ write, gate }) => {
      await write({ 'src/fresh.ts': lines(331) });
      const { exitCode, output } = gate();
      expect(exitCode).toBe(1);
      expect(output).toContain('src/legacy.ts is 400 lines');
      expect(output).toContain('src/fresh.ts is 331 lines');
    });
  });

  it('does not count tests, generated files, non-source files or git-ignored files', async () => {
    await withRepo({}, async ({ write, gate }) => {
      await write({
        '.gitignore': 'scratch/\n',
        'docs/big.md': lines(500),
        'scratch/big.ts': lines(500),
        'src/api.gen.ts': lines(500),
        'src/types.d.ts': lines(500),
        'src/client/store.test.ts': lines(500),
        'test/fixture/repo.ts': lines(500),
        'test/e2e/flow.spec.ts': lines(500),
      });
      expect(gate()).toEqual(clean);
    });
  });

  it('skips a file deleted from the working tree but still in the index', async () => {
    await withRepo({ 'src/gone.ts': lines(400) }, async ({ dir, gate }) => {
      await rm(join(dir, 'src/gone.ts'));
      expect(gate()).toEqual(clean);
    });
  });

  it('lets .locignore list a file by basename or path glob, and nothing else', async () => {
    await withRepo({}, async ({ write, gate }) => {
      await write({
        'src/table.ts': lines(500),
        'src/rules/catalog.ts': lines(500),
        'src/other.ts': lines(500),
        '.locignore': '# data catalogs\ntable.ts # one lookup table\nsrc/rules/*.ts\n',
      });
      const { exitCode, output } = gate();
      expect(exitCode).toBe(1);
      expect(output).toContain('src/other.ts');
      expect(output).not.toMatch(/table\.ts|catalog\.ts/);
    });
  });
});

describe('folder guard', () => {
  it('blocks a folder over the cap, counting direct children only', async () => {
    await withRepo({ ...stubs(15, 'src/lib'), ...stubs(15, 'src/parent/child') }, async ({ write, gate }) => {
      await write({ 'src/parent/one.ts': 'export const one = 1;\n' });
      expect(gate()).toEqual(clean);
      await write({ 'src/lib/m15.ts': 'export const v15 = 15;\n' });
      const result = gate();
      expect(result.exitCode).toBe(1);
      await expect(result.output).toMatchFileSnapshot('__snapshots__/quality-gate-folder.txt');
    });
  });

  it('does not count test folders, package roots or generated files', async () => {
    const generated = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/gen/g${i}.gen.ts`, '\n']));
    await withRepo(
      { ...stubs(20, 'test/unit'), ...stubs(20, 'tools'), 'tools/package.json': '{}\n', ...generated },
      async ({ gate }) => {
        expect(gate()).toEqual(clean);
      },
    );
  });

  it('lets .folderignore list a folder', async () => {
    await withRepo(stubs(16, 'src/flat'), async ({ write, gate }) => {
      expect(gate().exitCode).toBe(1);
      await write({ '.folderignore': '# one flat registry\nsrc/flat\n' });
      expect(gate()).toEqual(clean);
    });
  });
});
