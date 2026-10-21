// Writes THIRD_PARTY_NOTICES.md, which ships in every archive and npm package: the fonts
// (licenses-fonts.md), the packages the client build bundled (vite's licence plugin lists them in
// dist/*-licenses.json, so the client must be built first), and the crates the binary links
// (cargo-about over Cargo.lock, through about.toml and about.hbs). usage: node scripts/licenses.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/** One bundled package, as vite.config.ts has the licence plugin write it. */
interface Package {
  name: string;
  version: string;
  license: string | null;
  licenseText: string | null;
  noticeText: string | null;
  repository: string | null;
}

const SPDX_IDS = ['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD'];

const header = `# Third-party notices

diffle ships third-party software under the licences reproduced below: the fonts and the
packages bundled into the browser client, and the Rust crates linked into the binary.
\`pixi run licenses\` regenerates this file (\`scripts/licenses.ts\`).
`;

function packages(): Package[] {
  const seen = new Map<string, Package>();
  for (const bundle of ['client', 'worker']) {
    const listed: Package[] = JSON.parse(readFileSync(join(ROOT, 'dist', `${bundle}-licenses.json`), 'utf8'));
    for (const pkg of listed) seen.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function clientSection(): string {
  const all = packages();
  const byLicense = new Map<string, Package[]>();
  for (const pkg of all) {
    // package.json files spell the SPDX ids freely; one heading per licence, in canonical case.
    const key = SPDX_IDS.find((id) => id.toLowerCase() === pkg.license?.toLowerCase()) ?? pkg.license ?? 'unknown';
    byLicense.set(key, [...(byLicense.get(key) ?? []), pkg]);
  }
  const lines = [
    '## Client packages',
    '',
    'The browser client bundles the npm packages below, grouped by licence. Each package is followed',
    'by its own licence file, and its notice file where it ships one.',
    '',
    ...[...byLicense].map(([license, pkgs]) => `- ${license}: ${pkgs.length}`),
    '',
  ];
  for (const [license, pkgs] of byLicense) {
    lines.push(`### ${license}`, '');
    for (const pkg of pkgs) {
      lines.push(`#### ${pkg.name} ${pkg.version}${pkg.repository ? ` (${pkg.repository})` : ''}`, '');
      // A package without a licence file still declares its licence in package.json.
      if (pkg.licenseText) lines.push('```', pkg.licenseText.trim(), '```', '');
      else lines.push(`Ships no licence file; its package.json declares ${license}.`, '');
      if (pkg.noticeText) lines.push('```', pkg.noticeText.trim(), '```', '');
    }
  }
  return lines.join('\n');
}

const crates = execFileSync('cargo', ['about', 'generate', 'about.hbs'], { cwd: ROOT, encoding: 'utf8' });
const fonts = readFileSync(join(ROOT, 'scripts', 'licenses-fonts.md'), 'utf8');
writeFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), [header, fonts, clientSection(), crates].join('\n'));
console.error('wrote THIRD_PARTY_NOTICES.md');
