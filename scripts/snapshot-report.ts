import { writeFileSync } from 'node:fs';
import { generateSnapshotReport } from './lib/snapshot-report.js';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('usage: snapshot-report --base <rev> [--head <rev>] [--out <file>]');
  process.exit(2);
}

function parseArgs(argv: string[]) {
  let base: string | undefined;
  let head = 'HEAD';
  let out = 'snapshot-report.html';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--base' && value) base = argv[++i];
    else if (arg === '--head' && value) head = argv[++i]!;
    else if (arg === '--out' && value) out = argv[++i]!;
    else usage(`unexpected argument: ${arg}`);
  }
  if (!base) usage();
  return { base, head, out };
}

const { base, head, out } = parseArgs(process.argv.slice(2));
const { html, changed, unchanged } = generateSnapshotReport({ cwd: process.cwd(), base, head });
writeFileSync(out, html);
console.log(`${changed} changed snapshot${changed === 1 ? '' : 's'}, ${unchanged} unchanged → ${out}`);
