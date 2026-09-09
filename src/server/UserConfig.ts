import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_USER_CONFIG, type UserConfig } from '../shared/protocol.js';
import { writeFileAtomic } from './persist.js';

/** Owns `$XDG_CONFIG_HOME/diffle/config.json`. Machine-wide, not per repo. Writes are serialized. */
export class UserConfigStore {
  private writing: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly file: string,
    private config: UserConfig,
  ) {}

  static defaultPath(): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(base, 'diffle', 'config.json');
  }

  static async open(file = UserConfigStore.defaultPath()): Promise<UserConfigStore> {
    let config: UserConfig = { ...DEFAULT_USER_CONFIG };
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<UserConfig>;
      config = normalize(parsed);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error(`[diffle] ignoring unreadable config ${file}:`, e);
    }
    return new UserConfigStore(file, config);
  }

  get(): UserConfig {
    return this.config;
  }

  /** Merges `next` in and persists. Queued, so overlapping calls land in call order. */
  set(next: Partial<UserConfig>): Promise<UserConfig> {
    const write = this.writing.then(async () => {
      this.config = normalize({ ...this.config, ...next });
      // May hold a shell command: owner-only.
      await writeFileAtomic(this.file, JSON.stringify(this.config, null, 2) + '\n', 0o600);
      return this.config;
    });
    // A failed write rejects for its caller only; the queue stays usable.
    this.writing = write.catch(() => {});
    return write;
  }
}

function normalize(c: Partial<UserConfig>): UserConfig {
  const autoViewed = Array.isArray(c.autoViewed)
    ? c.autoViewed
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter(Boolean)
    : DEFAULT_USER_CONFIG.autoViewed;
  const contextLines =
    typeof c.contextLines === 'number' && Number.isFinite(c.contextLines)
      ? Math.max(0, Math.min(10_000, Math.floor(c.contextLines)))
      : DEFAULT_USER_CONFIG.contextLines;
  const lspCommand =
    typeof c.lspCommand === 'string' && c.lspCommand.trim() ? c.lspCommand.trim() : DEFAULT_USER_CONFIG.lspCommand;
  return { autoViewed, contextLines, lspCommand };
}
