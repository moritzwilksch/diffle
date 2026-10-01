import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DOWNLOADS = 'https://github.com/moritzwilksch/diffle/releases/download';

/** The release archive for a platform, named as the release workflow names it; null where none is built. */
export function releaseAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'linux') return `diffle-linux-${arch}.tar.gz`;
  if (platform === 'darwin') return arch === 'arm64' ? 'diffle-darwin-arm64.tar.gz' : null;
  if (platform === 'win32') return `diffle-windows-${arch}.zip`;
  return null;
}

export interface InstallOptions {
  /** The executable to replace. */
  target: string;
  /** Release tag, `vX.Y.Z`. */
  tag: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Where the tag's assets live; the release by default. A mirror, as `DIFFLE_DOWNLOAD_URL` names one for the installers. */
  base?: string;
  request?: typeof fetch;
}

/**
 * Puts `tag`'s binary for this platform in place of `target`, once its checksum matches the
 * release's SHA256SUMS and it answers `--version`. Returns that answer. Throws, leaving `target`
 * untouched, when any step fails.
 */
export async function installRelease({
  target,
  tag,
  platform = process.platform,
  arch = process.arch,
  base = `${DOWNLOADS}/${tag}`,
  request = fetch,
}: InstallOptions): Promise<string> {
  const asset = releaseAsset(platform, arch);
  if (!asset) throw new Error(`no release binary for ${platform}-${arch}; install with npm or pixi instead`);
  const download = async (url: string) => {
    const response = await request(url, { signal: AbortSignal.timeout(120_000) }).catch((e: unknown) => {
      // fetch says only "fetch failed"; the reason is its cause.
      const reason = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
      throw new Error(`download failed: ${url}: ${reason}`);
    });
    if (!response.ok) throw new Error(`download failed: ${url}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const [archive, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/SHA256SUMS`)]);
  const expected = checksumFor(sums.toString('utf8'), asset);
  if (!expected) throw new Error(`SHA256SUMS lists no ${asset}`);
  if (createHash('sha256').update(archive).digest('hex') !== expected.toLowerCase())
    throw new Error(`checksum mismatch for ${asset}`);

  const dir = dirname(target);
  let tmp: string;
  try {
    // Beside the target, so the final rename stays on one filesystem.
    tmp = await mkdtemp(join(dir, '.diffle-update-'));
  } catch (e) {
    throw new Error(
      `cannot write to ${dir} (${(e as NodeJS.ErrnoException).code}): run the update as the user that installed diffle`,
    );
  }
  try {
    const archivePath = join(tmp, asset);
    await writeFile(archivePath, archive);
    const name = platform === 'win32' ? 'diffle.exe' : 'diffle';
    await run(tar(platform), ['-xf', archivePath, '-C', tmp, name]);
    const next = join(tmp, name);
    if (platform !== 'win32') await chmod(next, 0o755);
    const { stdout } = await run(next, ['--version'], { timeout: 30_000 });
    await replaceExecutable(target, next, platform);
    return stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The hash `SHA256SUMS` lists for `name`; a `*` before the name marks binary mode in sha256sum's format. */
export function checksumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file?.replace(/^\*/, '') === name) return hash;
  }
  return null;
}

/** Windows' own bsdtar reads zip archives; a Git for Windows tar earlier on PATH does not. */
function tar(platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

/**
 * Puts `next` where `target` is. A rename keeps a running diffle on its own inode (and macOS on
 * its signature cache). Windows cannot replace a running executable but can rename it, so the old
 * one steps aside as `<target>.old` until a later start removes it.
 */
export async function replaceExecutable(
  target: string,
  next: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') return rename(next, target);
  const old = `${target}.old`;
  await rm(old, { force: true });
  await rename(target, old);
  try {
    await rename(next, target);
  } catch (e) {
    await rename(old, target);
    throw e;
  }
}
