// Assembles the npm packages from the release archives: one package per platform holding the
// binary, and the launcher package (`npm/`) that depends on all of them optionally, so npm installs
// the matching one. usage: node scripts/npm-packages.ts <archives dir> <out dir> [--smoke]
// Plain node runs it: no dependencies, and Node 24 strips the types itself.
//
// The platform packages are named after Node's `process.platform` and `process.arch`, which the
// launcher uses to find its binary. `--smoke` installs the assembled packages for this host into a
// temporary prefix and runs `diffle --version` through the launcher.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SCOPE = '@moritzwilksch';

interface Platform {
  os: NodeJS.Platform;
  cpu: NodeJS.Architecture;
}

/** Release archive name → the npm platform it serves. */
export const TARGETS: Record<string, Platform> = {
  'linux-x64': { os: 'linux', cpu: 'x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'windows-x64': { os: 'win32', cpu: 'x64' },
  'windows-arm64': { os: 'win32', cpu: 'arm64' },
};

const platformName = ({ os, cpu }: Platform) => `diffle-${os}-${cpu}`;

/** Writes every package whose archive is present under `archives` into `out`; returns the platform package names. */
export function assemble(archives: string, out: string): { version: string; built: string[] } {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
    license: string;
    repository: unknown;
  };
  const { version } = root;
  const built: string[] = [];
  for (const [target, platform] of Object.entries(TARGETS)) {
    const archive = join(archives, `diffle-${target}.${platform.os === 'win32' ? 'zip' : 'tar.gz'}`);
    if (!existsSync(archive)) continue;
    const name = platformName(platform);
    const dir = join(out, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    extract(archive, dir);
    const manifest = {
      name: `${SCOPE}/${name}`,
      version,
      description: `The diffle binary for ${platform.os} ${platform.cpu}`,
      license: root.license,
      repository: root.repository,
      os: [platform.os],
      cpu: [platform.cpu],
    };
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    built.push(name);
  }
  const launcher = join(out, 'diffle');
  rmSync(launcher, { recursive: true, force: true });
  cpSync(join(ROOT, 'npm'), launcher, { recursive: true });
  cpSync(join(ROOT, 'README.md'), join(launcher, 'README.md'));
  cpSync(join(ROOT, 'LICENSE'), join(launcher, 'LICENSE'));
  cpSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(launcher, 'THIRD_PARTY_NOTICES.md'));
  const manifest = JSON.parse(readFileSync(join(launcher, 'package.json'), 'utf8')) as Record<string, unknown>;
  manifest.version = version;
  // Every platform, built or not: a missing package is skipped at install time, and its absence
  // is the launcher's error, not npm's.
  manifest.optionalDependencies = Object.fromEntries(
    Object.values(TARGETS).map((platform) => [`${SCOPE}/${platformName(platform)}`, version]),
  );
  writeFileSync(join(launcher, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { version, built };
}

/** The archive's files into `dir`: the binary, LICENSE and the notices. */
function extract(archive: string, dir: string): void {
  if (archive.endsWith('.zip')) execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);
  else execFileSync('tar', ['-xzf', archive, '-C', dir]);
}

/**
 * Installs the launcher and this host's platform package from `out` into a temporary prefix
 * without the registry, then runs `diffle --version` through the launcher.
 */
export function smoke(out: string, version: string): string {
  const name = platformName({ os: process.platform, cpu: process.arch });
  if (!existsSync(join(out, name))) throw new Error(`no package for this host (${name}) under ${out}`);
  const prefix = mkdtempSync(join(tmpdir(), 'diffle-npm-'));
  try {
    const scope = join(prefix, 'node_modules', SCOPE);
    mkdirSync(scope, { recursive: true });
    cpSync(join(out, 'diffle'), join(scope, 'diffle'), { recursive: true });
    cpSync(join(out, name), join(scope, name), { recursive: true });
    const launcher = join(scope, 'diffle', 'bin', 'diffle.js');
    const printed = execFileSync(process.execPath, [launcher, '--version'], {
      encoding: 'utf8',
      // Compared byte for byte, so no colour, whatever CI forces on the terminal.
      env: { ...process.env, NO_COLOR: '1' },
    }).trim();
    if (printed !== version) throw new Error(`the launcher ran a binary reporting ${printed}, not ${version}`);
    return printed;
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archives, out, flag] = process.argv.slice(2);
  if (!archives || !out) {
    console.error('usage: node scripts/npm-packages.ts <archives dir> <out dir> [--smoke]');
    process.exit(2);
  }
  const { version, built } = assemble(resolve(archives), resolve(out));
  console.log(`assembled ${SCOPE}/diffle ${version} with ${built.join(', ')}`);
  if (flag === '--smoke') console.log(`launcher ran diffle ${smoke(resolve(out), version)}`);
}
