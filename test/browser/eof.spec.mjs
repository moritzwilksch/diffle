import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

let repo;
let server;
let url;

test.beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'diffle-eof-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
  const contents = Array.from(
    { length: 85 },
    (_, i) => `line_${i + 1}: ${i === 33 ? 'wrapped text '.repeat(20) : 'value'}\n`,
  ).join('');
  await Promise.all(['recipe.yaml', 'second.yaml'].map((path) => writeFile(join(repo, path), contents)));
  server = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli/main.ts', 'working', '-C', repo, '--no-open', '--no-watch', '--dev', '-p', '0'],
    { cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  url = await new Promise((resolve, reject) => {
    let output = '';
    server.stderr.on('data', (data) => {
      output += data;
      const match = output.match(/diffle running at (http:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    server.on('error', reject);
    server.on('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
  });
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
  }
  if (repo) await rm(repo, { recursive: true, force: true });
});

test('an added file reaches EOF before the next file starts (#9, #54)', async ({ page }) => {
  await page.goto(url);
  const first = page
    .locator('diffs-container')
    .filter({ has: page.locator('[data-title]', { hasText: /^recipe\.yaml$/ }) });
  const second = page
    .locator('diffs-container')
    .filter({ has: page.locator('[data-title]', { hasText: /^second\.yaml$/ }) });
  const rows = first.locator('[data-content] > [data-line-index]');
  await expect(rows.first()).toContainText('line_1:');

  // Measure rows, then put EOF just above the viewport midpoint. With 20px estimates
  // for the app's 18px rows, the virtual range stops at 82 and the next card hides 83–85.
  await page.locator('.codeview').evaluate((el) => {
    el.scrollTop = 700;
  });
  await expect(rows.first()).not.toContainText('line_1:');
  await page.locator('.codeview').evaluate((el) => {
    el.scrollTop = 1190;
  });
  await expect(second.locator('[data-title]')).toBeInViewport();
  await expect(rows.last()).toHaveText('line_85: value');
  await expect(rows.last()).toBeInViewport();
});
