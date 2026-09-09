import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MAIN = join(process.cwd(), 'src', 'cli', 'main.ts');

function help(...args: string[]): string {
  return execFileSync(process.execPath, [TSX, MAIN, ...args, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', COLUMNS: '100' },
  });
}

describe('diffle --help', () => {
  const out = help();
  const commands = out.slice(out.indexOf('\nCommands:')).split('\nShorthands')[0]!;

  it('keeps the shorthands out of the command list, in a section of their own', () => {
    for (const shorthand of ['working', 'branch', 'pr']) expect(commands).not.toMatch(new RegExp(`^ +${shorthand}\\b`, 'm'));
    const shorthands = out.slice(out.indexOf('Shorthands'));
    for (const shorthand of ['working', 'branch [base]', 'pr [number|url]']) expect(shorthands).toContain(shorthand);
  });

  it('still lists the commands, which are verbs', () => {
    for (const command of ['export', 'comment', 'config']) expect(commands).toMatch(new RegExp(`^ +${command}\\b`, 'm'));
  });

  it('says what each shorthand is the same as before explaining it', () => {
    expect(out).toMatch(/^ {2}working {2,}same as HEAD: /m);
    expect(out).toMatch(/^ {2}branch \[base] {2,}same as <base>\.\.\.HEAD: /m);
  });

  it('carries no empty defaults for the repeatable options', () => {
    expect(out).not.toContain('(default: [])');
    expect(out).not.toContain('(default: false)');
  });

  it('describes every shorthand and config subcommand it lists', () => {
    for (const shorthand of ['working', 'branch', 'pr']) expect(help(shorthand).split('\n')[2]).not.toBe('');
    const configCommands = help('config').slice(help('config').indexOf('\nCommands:'));
    for (const line of configCommands.split('\n').slice(2).filter(Boolean)) expect(line).toMatch(/\S {2,}\S/);
  });
});
