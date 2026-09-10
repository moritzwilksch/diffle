#!/usr/bin/env node
// Publish screenshot files to a branch and print their raw URLs, for embedding in a PR body.
// GitHub can't attach images to a PR body through the API, so they live on a side branch.
//
//   node publish.mjs --dir /tmp/shots --repo owner/name --branch screenshots/pr-119
//
// Files are placed under `--prefix` (default `.github/assets/<branch basename>`). Re-runs
// update in place, so re-capturing is safe.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, posix } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  for (const required of ['dir', 'repo', 'branch']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function gh(args, { quiet = false } = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'ignore'] : 'pipe' });
}

function branchSha(repo, branch) {
  try {
    return JSON.parse(gh(['api', `repos/${repo}/git/ref/heads/${branch}`], { quiet: true })).object.sha;
  } catch {
    return null;
  }
}

function encodedPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function existingSha(repo, path, branch) {
  try {
    return JSON.parse(
      gh(['api', `repos/${repo}/contents/${encodedPath(path)}?ref=${encodeURIComponent(branch)}`], { quiet: true }),
    ).sha;
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
const repo = args.repo;
const branch = args.branch;
const prefix = (args.prefix ?? posix.join('.github/assets', branch.split('/').pop())).replace(/^\/|\/$/g, '');

if (!branchSha(repo, branch)) {
  const base = args.base ?? 'main';
  const sha = branchSha(repo, base);
  if (!sha) throw new Error(`base branch ${base} not found in ${repo}`);
  gh(['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
  console.log(`created ${branch} from ${base}`);
}

const files = readdirSync(args.dir)
  .filter((name) => IMAGE.has(extname(name).toLowerCase()))
  .sort();
if (files.length === 0) throw new Error(`no images in ${args.dir}`);

for (const name of files) {
  const path = posix.join(prefix, name);
  const sha = existingSha(repo, path, branch);
  const fields = [
    '--method',
    'PUT',
    `repos/${repo}/contents/${encodedPath(path)}`,
    '-f',
    `message=docs(screenshots): ${sha ? 'update' : 'add'} ${name}`,
    '-f',
    `content=${readFileSync(join(args.dir, name)).toString('base64')}`,
    '-f',
    `branch=${branch}`,
  ];
  if (sha) fields.push('-f', `sha=${sha}`);
  gh(['api', ...fields]);
  console.log(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`);
}
