import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completionScript, SHELLS, type Shell } from '../../src/cli/completion.js';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');
const env = { ...process.env, NO_COLOR: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

/** Reads the script the CLI prints, so the tests see what a user would load. */
function generate(shell: Shell): string {
  return execFileSync(process.execPath, [TSX, MAIN, 'completion', shell], { encoding: 'utf8', env });
}

function installed(shell: Shell): boolean {
  try {
    execFileSync(shell, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Startup flags that keep a shell from reading the machine's own configuration. */
const HERMETIC: Record<Shell, string[]> = { bash: ['--noprofile', '--norc'], zsh: ['-f'], fish: ['--no-config'] };

/**
 * Each driver loads the generated script, asks it to complete `<words...>` (the
 * last word being the one under the cursor) and prints one candidate per line.
 * bash and fish complete for real; zsh's completion system only runs inside the
 * line editor, so the driver stands in for it and reports what it was offered.
 */
const DRIVERS: Record<Shell, string> = {
  bash: `source "$1"
shift
COMP_WORDS=("$@")
COMP_CWORD=$(( $# - 1 ))
COMPREPLY=()
_diffle
printf '%s\\n' "\${COMPREPLY[@]}"
`,
  zsh: `_describe() { print -l -- \${\${(P)4}%%:*} }
_files() { print -l -- '<file>' }
_directories() { print -l -- '<dir>' }
compdef() { }
source $1
shift
words=("$@")
CURRENT=$#words
_diffle
`,
  fish: `source $argv[1]
complete -C (string join -- ' ' $argv[2..-1])
`,
};

let dir: string;
/** A repository with known refs, files and directories, so candidates are predictable. */
let repo: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffle-completion-'));
  repo = join(dir, 'repo');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, env });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  await mkdir(join(repo, 'sub'));
  await writeFile(join(repo, 'app.py'), 'x = 1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('tag', 'v1');
  for (const shell of SHELLS) {
    await writeFile(join(dir, `diffle.${shell}`), generate(shell));
    await writeFile(join(dir, `driver.${shell}`), DRIVERS[shell]);
  }
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What the shell offers for a command line whose last word is under the cursor. */
function candidates(shell: Shell, ...words: string[]): string[] {
  const out = execFileSync(shell, [...HERMETIC[shell], join(dir, `driver.${shell}`), join(dir, `diffle.${shell}`), ...words], {
    cwd: repo,
    encoding: 'utf8',
    env,
  });
  // fish prints "candidate<TAB>description"; a trailing slash marks a directory.
  return out.split('\n').map((l) => l.split('\t')[0]!.trim().replace(/\/$/, '')).filter(Boolean);
}

describe.each(SHELLS)('diffle completion %s', (shell) => {
  const skip = !installed(shell);

  it.skipIf(skip)('prints a script the shell itself parses', () => {
    execFileSync(shell, ['-n', join(dir, `diffle.${shell}`)], { stdio: 'pipe' });
  });

  it.skipIf(skip)('completes subcommands, and revisions where a revspec goes', () => {
    const root = candidates(shell, 'diffle', '');
    expect(root).toEqual(expect.arrayContaining(['working', 'branch', 'pr', 'export', 'comment', 'config', 'completion', 'HEAD', 'main', 'v1']));
    expect(candidates(shell, 'diffle', 'comment', '')).toEqual(expect.arrayContaining(['add', 'get', 'reply', 'resolve']));
    expect(candidates(shell, 'diffle', 'config', '')).toEqual(expect.arrayContaining(['show', 'add-auto-viewed', 'set-context', 'set-lsp']));
    // A mode argument takes a name or a revspec.
    expect(candidates(shell, 'diffle', 'export', '')).toEqual(expect.arrayContaining(['working', 'pr', 'main']));
  });

  it.skipIf(skip)('completes the closed sets of values, and nothing where a value is free text', () => {
    expect(candidates(shell, 'diffle', 'comment', 'get', '--state', '').sort()).toEqual(['all', 'open', 'resolved']);
    expect(candidates(shell, 'diffle', 'export', '--format', '').sort()).toEqual(['json', 'prompt']);
    expect(candidates(shell, 'diffle', 'completion', '').sort()).toEqual(['bash', 'fish', 'zsh']);
    expect(candidates(shell, 'diffle', 'comment', 'reply', 'id', '--as', '')).toEqual([]);
  });

  it.skipIf(skip)('completes paths where a path goes, and nowhere else', () => {
    expect(candidates(shell, 'diffle', '-C', 's')).toEqual(expect.arrayContaining([shell === 'zsh' ? '<dir>' : 'sub']));
    expect(candidates(shell, 'diffle', 'comment', 'add', 'a')).toEqual(expect.arrayContaining([shell === 'zsh' ? '<file>' : 'app.py']));
    // A subcommand is not a path.
    expect(candidates(shell, 'diffle', 'comment', '')).not.toContain('app.py');
  });

  it.skipIf(skip)('offers the flags a command accepts, its own and the global ones', () => {
    const flags = candidates(shell, 'diffle', 'comment', 'get', '--');
    expect(flags).toEqual(expect.arrayContaining(['--state', '--format', '--path', '--url', '--help', '--host']));
  });

  it.skipIf(skip)("reads a flag's value as a value, not as a subcommand", () => {
    // `4000` is the port, so the cursor is still in `diffle` itself.
    expect(candidates(shell, 'diffle', '--port', '4000', '')).toEqual(expect.arrayContaining(['working', 'comment']));
  });
});

describe('the generated scripts', () => {
  it('name every command and flag of the CLI, because they are generated from it', () => {
    const program = new Command().name('diffle').option('--brand-new <value>', 'a flag nobody has written a completion for');
    program.command('surprise').description('a command added after this test');
    for (const shell of SHELLS) {
      const script = completionScript(program, shell);
      expect(script).toContain('--brand-new');
      expect(script).toContain('surprise');
    }
  });

  it('rejects a shell it cannot generate for', () => {
    expect(() => execFileSync(process.execPath, [TSX, MAIN, 'completion', 'csh'], { encoding: 'utf8', env, stdio: 'pipe' })).toThrow(
      /expected bash, zsh, fish/,
    );
  });
});
