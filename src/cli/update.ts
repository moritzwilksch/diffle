import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { writeFileAtomic } from '../server/persist.js';

export const RELEASES_URL = 'https://api.github.com/repos/moritzwilksch/diffle/releases/latest';
const MAX_AGE = 24 * 60 * 60 * 1000;

/** True in a build that may replace itself with a newer release: the single executable GitHub releases ship. */
export const SELF_UPDATE = typeof __DIFFLE_SELF_UPDATE__ !== 'undefined' && __DIFFLE_SELF_UPDATE__ === true;

const ReleaseSchema = z.object({ tag_name: z.string(), html_url: z.url({ protocol: /^https$/ }) });
const CacheSchema = z.object({ source: z.string(), checkedAt: z.number(), version: z.string(), url: z.url() });

export interface Release {
  /** Without the tag's `v`. */
  version: string;
  /** The release page. */
  url: string;
}

export interface LookupOptions {
  /** The `releases/latest` endpoint; `DIFFLE_UPDATE_URL` overrides it. */
  source?: string;
  cacheFile?: string;
  /** How old a cached answer may be, in milliseconds; a day by default. */
  maxAge?: number;
  request?: typeof fetch;
  now?: () => number;
}

/**
 * The newest published release. Asks GitHub at most once a day per machine; offline or rate
 * limited, it answers with the last good copy, else null. Never rejects.
 */
export async function latestRelease({
  source = process.env.DIFFLE_UPDATE_URL || RELEASES_URL,
  cacheFile = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'diffle', 'latest-release.json'),
  maxAge = MAX_AGE,
  request = fetch,
  now = Date.now,
}: LookupOptions = {}): Promise<Release | null> {
  let cached: Release | null = null;
  try {
    const entry = CacheSchema.parse(JSON.parse(await readFile(cacheFile, 'utf8')));
    // A cache filled from another endpoint (a test's stub) says nothing about this one.
    if (entry.source === source) {
      cached = { version: entry.version, url: entry.url };
      if (now() - entry.checkedAt < maxAge) return cached;
    }
  } catch {
    /* No usable cache yet. */
  }
  try {
    const response = await request(source, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `diffle/${pkg.version}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return cached;
    const parsed = ReleaseSchema.safeParse(await response.json());
    if (!parsed.success) return cached;
    const release = { version: parsed.data.tag_name.replace(/^v/, ''), url: parsed.data.html_url };
    // Cache failure must not hide the answer in read-only environments.
    await writeFileAtomic(cacheFile, JSON.stringify({ source, checkedAt: now(), ...release }) + '\n').catch(() => {});
    return release;
  } catch {
    return cached;
  }
}

/** True when `a` is a later `x.y.z[-pre]` version than `b`; a release outranks its prereleases. */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i]! > pb.core[i]!;
  return !pa.pre && pb.pre;
}

function parseVersion(v: string): { core: number[]; pre: boolean } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(\+[\w.-]+)?$/.exec(v.trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] != null } : null;
}

/**
 * How the running diffle was installed. `binary` is the self-updating single executable; the rest
 * are judged by where its code lives, and `source` covers a checkout or anything unrecognized.
 */
export type InstallChannel = 'binary' | 'npx' | 'npm' | 'pixi-global' | 'pixi' | 'conda' | 'nix' | 'source';

export interface ChannelOptions {
  home?: string;
  /** `PIXI_HOME`; pixi's global environments live under it, `~/.pixi` by default. */
  pixiHome?: string;
  /** True for a conda environment's root. Test seam. */
  isCondaPrefix?: (dir: string) => boolean;
}

/**
 * The channel of a diffle whose code is `script`: its entry script, or a repackaged single
 * executable itself. An absolute path with symlinks resolved.
 */
export function installChannel(
  script: string,
  {
    home = homedir(),
    pixiHome = process.env.PIXI_HOME,
    isCondaPrefix = (dir) => existsSync(join(dir, 'conda-meta')),
  }: ChannelOptions = {},
): Exclude<InstallChannel, 'binary'> {
  const path = slashes(script);
  if (path.startsWith('/nix/store/')) return 'nix';
  if (path.includes('/_npx/')) return 'npx';
  // Before npm: conda-forge's package is the npm one, unpacked under the environment's node_modules.
  for (let dir = dirname(script); dir !== dirname(dir); dir = dirname(dir)) {
    if (!isCondaPrefix(dir)) continue;
    const prefix = slashes(dir) + '/';
    if (prefix.startsWith(slashes(join(pixiHome || join(home, '.pixi'), 'envs')) + '/')) return 'pixi-global';
    return prefix.includes('/.pixi/envs/') ? 'pixi' : 'conda';
  }
  if (path.includes('/node_modules/')) return 'npm';
  return 'source';
}

function slashes(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * The command that updates a diffle installed through `channel`; null where diffle cannot know
 * it (a conda environment, a Nix profile or flake, a checkout).
 */
export function updateCommand(channel: InstallChannel): string | null {
  switch (channel) {
    case 'binary':
      return 'diffle self-update';
    case 'npx':
      return 'npx @moritzwilksch/diffle@latest';
    case 'npm':
      return 'npm install -g @moritzwilksch/diffle@latest';
    case 'pixi-global':
      return 'pixi global update diffle';
    case 'pixi':
      return 'pixi update diffle';
    case 'conda':
    case 'nix':
    case 'source':
      return null;
  }
}
