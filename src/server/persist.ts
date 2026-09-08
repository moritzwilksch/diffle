import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A holder older than this is presumed hung, even when its pid is alive. */
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

let seq = 0;

/**
 * Writes `text` to `file` atomically: unique temp file in the same directory,
 * then rename. Creates the directory owner-only; the file gets `mode`. A failed
 * write leaves no temp file behind.
 */
export async function writeFileAtomic(file: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // pid alone collides between instances in one process; the counter and nonce make it unique.
  const tmp = `${file}.${process.pid}.${++seq}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

const inProcess = new Map<string, Promise<void>>();

/**
 * Runs `fn` while holding `<file>.lock`, exclusive across processes on this
 * machine and serialized within this one. A lock whose pid is dead, or older
 * than 30s, is taken over; waiting longer than 10s throws. The lock is
 * released whether `fn` resolves or rejects.
 */
export async function withFileLock<R>(file: string, fn: () => Promise<R>): Promise<R> {
  // Queue in-process first so instances in one server never spin on the lock file.
  const prev = inProcess.get(file) ?? Promise.resolve();
  let release!: () => void;
  const chain = prev.then(() => new Promise<void>((r) => (release = r)));
  inProcess.set(file, chain);
  await prev;
  const lock = `${file}.lock`;
  try {
    await acquire(lock);
    try {
      return await fn();
    } finally {
      await unlink(lock).catch(() => {});
    }
  } finally {
    release();
    if (inProcess.get(file) === chain) inProcess.delete(file);
  }
}

async function acquire(lock: string): Promise<void> {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await open(lock, 'wx', 0o600);
      try {
        await fh.writeFile(`${process.pid}\n`);
      } finally {
        await fh.close();
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (await isStale(lock)) {
      await unlink(lock).catch(() => {});
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
    await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
  }
}

/** True when the holder is gone: dead pid, or too old to trust. A lock with no pid yet is being taken. */
async function isStale(lock: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof stat>>;
  let text: string;
  try {
    [st, text] = await Promise.all([stat(lock), readFile(lock, 'utf8')]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return true;
  const pid = Number.parseInt(text, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
