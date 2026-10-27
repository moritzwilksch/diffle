// Minimal report generator for the server tests. Reads the review from stdin and the copied sides
// from DIFFLE_OLD and DIFFLE_NEW. `json` (the default) writes report.json with what it saw and one
// PNG page into DIFFLE_OUT; `stdout` prints one markdown line for DIFFLE_FILE instead; `fail` exits 3.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'json';
const input = JSON.parse(readFileSync(0, 'utf8'));

function walk(dir, prefix = '') {
  let out = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, name)).isDirectory()) out = out.concat(walk(join(dir, name), rel));
    else out.push(rel);
  }
  return out;
}

const old = walk(process.env.DIFFLE_OLD);
const next = walk(process.env.DIFFLE_NEW);
// The matched files' new text, for a test to check the copy; the rest of a tree would be noise.
const contents = input.files
  .filter((f) => existsSync(join(process.env.DIFFLE_NEW, f.path)))
  .map((f) => `${f.path}=${readFileSync(join(process.env.DIFFLE_NEW, f.path), 'utf8').trim()}`);

if (mode === 'fail') {
  process.stderr.write('boom: no such thing\n');
  process.exit(3);
}
if (mode === 'stdout') {
  console.log(`${process.env.DIFFLE_FILE ?? 'all'}: old=${old.join(',')} new=${next.join(',')}`);
  process.exit(0);
}
// A side's logo, when the repository has one (the e2e fixture does), else bytes that only sniff as PNG.
const stub = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(contents.join(';')),
]);
const logo = (dir) => (existsSync(join(dir, 'assets/logo.png')) ? readFileSync(join(dir, 'assets/logo.png')) : null);
writeFileSync(join(process.env.DIFFLE_OUT, 'page.png'), logo(process.env.DIFFLE_NEW) ?? stub);
const oldLogo = logo(process.env.DIFFLE_OLD);
if (oldLogo) writeFileSync(join(process.env.DIFFLE_OUT, 'old.png'), oldLogo);
const report = {
  title: 'Fake report',
  blocks: [
    {
      kind: 'markdown',
      text: `old: ${old.join(', ')}\nnew: ${next.join(', ')}\nscope: ${input.scope}\nfiles: ${input.files.map((f) => f.path).join(', ')}\ncontents: ${contents.join('; ')}`,
      anchor: { path: input.files[0]?.path ?? 'none', line: 1 },
    },
    { kind: 'pages', label: 'Rendered', pages: [{ label: 'p. 1', old: oldLogo ? 'old.png' : null, new: 'page.png' }] },
  ],
};
writeFileSync(join(process.env.DIFFLE_OUT, 'report.json'), JSON.stringify(report));
process.stderr.write('rendered 1 page\n');
