import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, open, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ChangedFile, ChangeStatus, CommitInfo, LastCommitsPreview, RefsResponse } from '../../shared/protocol.js';
import { mapLimit } from '../concurrency.js';

const MAX_BUFFER = 512 * 1024 * 1024;
/** A search that runs this long is a runaway regex, not a slow repository. */
const GREP_TIMEOUT_MS = 10_000;
/** Concurrent worktree reads while sizing untracked files. */
const READ_CONCURRENCY = 8;
/**
 * Git's `core.bigFileThreshold` default: a file this large is diffed as binary
 * without reading it, which also bounds what sizing an untracked file loads.
 */
export const BIG_FILE_THRESHOLD = 512 * 1024 * 1024;
/**
 * `diff`, `log` and `grep` are porcelain and honour the user's config. These
 * overrides keep their output in the shape the parsers expect: no colour, `a/`
 * `b/` prefixes, and non-ASCII paths written verbatim instead of C-quoted.
 * `color.ui` does not beat a per-command `color.diff`/`color.grep=always`, so
 * those are pinned too.
 */
const CONFIG_ARGS = [
  '-c',
  'color.ui=never',
  '-c',
  'color.diff=never',
  '-c',
  'color.grep=never',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'core.quotePath=false',
];
/** Fixed header prefixes and no `diff.external`, so a patch is always a unified diff. */
const PATCH_ARGS = ['--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
/** An idle `cat-file --batch` is reaped after this long; the next request respawns one. */
const CAT_FILE_IDLE_MS = 2000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

interface ExecOptions {
  /** Exit codes that are not errors (e.g. 1 for `diff --no-index`). */
  okCodes?: number[];
  input?: string;
  /** Merged over the inherited environment. */
  env?: Record<string, string>;
}

interface RecordOptions extends ExecOptions {
  /** Kill the child and reject after this long. */
  timeoutMs?: number;
}

/** The only module that spawns git. All calls run with cwd = repo root, except reading a submodule's HEAD inside it. */
export class GitRepo {
  private constructor(
    readonly root: string,
    readonly gitDir: string,
    /** Shared dir for worktrees (refs, packed-refs). Equals gitDir for the main worktree. */
    readonly commonDir: string,
  ) {
    this.catFile = new CatFileBatch(root);
  }

  private readonly catFile: CatFileBatch;
  readonly reviewRefs = `refs/diffle/${randomUUID()}`;

  /** Clone into an empty temporary directory; full history preserves merge bases. */
  static async clone(url: string, dir: string): Promise<GitRepo> {
    await execGit(dir, ['clone', '--quiet', '--no-tags', '--', url, '.'], { env: { GIT_TERMINAL_PROMPT: '0' } });
    return GitRepo.open(dir);
  }

  /** Remove only refs owned by this review, never another running instance. */
  async cleanReviewRefs(): Promise<void> {
    const refs = (await this.text(['for-each-ref', '--format=%(refname)', `${this.reviewRefs}/`])).trim();
    if (refs)
      await this.exec(['update-ref', '--stdin'], {
        input: refs
          .split('\n')
          .map((ref) => `delete ${ref}\n`)
          .join(''),
      });
  }

  /** How many `cat-file --batch` processes this repository has started. Diagnostics and tests. */
  get catFileSpawns(): number {
    return this.catFile.spawns;
  }

  static async open(dir: string): Promise<GitRepo> {
    const out = await execGit(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
    const [root, gitDir, common] = out.toString('utf8').trim().split('\n');
    if (!root || !gitDir) throw new GitError(`not a git repository: ${dir}`, [], 128, '');
    const commonDir = common ? resolve(root, common) : gitDir;
    // Git prints POSIX separators even on Windows; resolve them to native ones
    // so every path this class hands out compares equal to a `join`ed one.
    return new GitRepo(resolve(root), resolve(gitDir), commonDir);
  }

  private exec(args: string[], opts: ExecOptions = {}): Promise<Buffer> {
    return execGit(this.root, args, opts);
  }

  private async text(args: string[], opts?: ExecOptions): Promise<string> {
    return (await this.exec(args, opts)).toString('utf8');
  }

  /** Commit sha for a user-supplied revision. `--end-of-options` keeps an option-shaped name a name. */
  async resolve(rev: string): Promise<string> {
    return (await this.text(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])).trim();
  }

  /** Commit messages for two ancestor offsets, pinned to one HEAD. */
  async lastCommitsPreview(oldOffset: number, newOffset: number): Promise<LastCommitsPreview> {
    const head = await this.commitInfo('HEAD');
    if (!head) return { old: null, new: null };
    const at = (offset: number) => (offset === 0 ? Promise.resolve(head) : this.commitInfo(`${head.sha}~${offset}`));
    const [old, next] = await Promise.all([at(oldOffset), at(newOffset)]);
    return { old, new: next };
  }

  private async commitInfo(rev: string): Promise<CommitInfo | null> {
    let sha: string;
    try {
      sha = await this.resolve(rev);
    } catch (e) {
      if (e instanceof GitError && e.code === 1) return null;
      throw e;
    }
    const output = await this.text(['log', '-1', '--no-show-signature', '--format=%h%x00%B', sha, '--']);
    const separator = output.indexOf('\0');
    return { sha, short: output.slice(0, separator), message: output.slice(separator + 1).trimEnd() };
  }

  /** The empty tree under the repository's hash algorithm: the old side of an unborn branch. */
  async emptyTree(): Promise<string> {
    return (await this.text(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.text(['merge-base', '--end-of-options', a, b])).trim();
  }

  /** origin/HEAD → main → master. */
  async defaultBranch(): Promise<string> {
    try {
      const ref = (await this.text(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim();
      if (ref) return ref;
    } catch {
      /* no origin/HEAD */
    }
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      try {
        await this.resolve(candidate);
        return candidate;
      } catch {
        /* try next */
      }
    }
    throw new GitError('cannot determine default branch; pass a base explicitly', [], null, '');
  }

  /** The checked-out branch's configured upstream, or null when HEAD is detached or untracked. */
  async upstreamBranch(): Promise<{ remote: string; branch: string } | null> {
    let head: string;
    try {
      head = (await this.text(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    } catch (e) {
      if (e instanceof GitError && e.code === 1) return null;
      throw e;
    }
    const out = await this.text(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00', head]);
    const [remote, ref] = out.split('\0');
    if (!remote || remote === '.' || !ref?.startsWith('refs/heads/')) return null;
    return { remote, branch: ref.slice('refs/heads/'.length) };
  }

  /** Configured remotes, in git's order, with their fetch URLs. */
  async remotes(): Promise<{ name: string; url: string }[]> {
    // Read configured URLs before insteadOf rewriting, which can hide repository identity.
    const out = await this.text(['config', '--null', '--get-regexp', '^remote\\..*\\.url$'], { okCodes: [1] });
    const seen = new Map<string, string>();
    for (const record of out.split('\0')) {
      const m = /^remote\.(.*)\.url\n([\s\S]*)$/.exec(record);
      if (m && !seen.has(m[1]!)) seen.set(m[1]!, m[2]!);
    }
    return [...seen].map(([name, url]) => ({ name, url }));
  }

  /**
   * Fetches explicit refspecs from `remote` (a name or a URL). The
   * refspecs must stay inside `refs/diffle/`, so no ref the user owns moves, and
   * FETCH_HEAD is left alone. Terminal prompts are off: a repository that needs
   * credentials fails instead of hanging.
   */
  async fetch(remote: string, refspecs: string[]): Promise<void> {
    for (const spec of refspecs) {
      const dst = spec.slice(spec.indexOf(':') + 1);
      if (!dst.startsWith('refs/diffle/')) throw new GitError(`refusing to fetch into ${dst}`, ['fetch'], null, '');
    }
    await this.exec(
      ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--end-of-options', remote, ...refspecs],
      {
        env: { GIT_TERMINAL_PROMPT: '0' },
      },
    );
  }

  async lsFiles(): Promise<string[]> {
    return splitZ(await this.exec(['ls-files', '-z']));
  }

  /** Every path in a commit's tree. */
  async lsTree(rev: string): Promise<string[]> {
    return splitZ(await this.exec(['ls-tree', '-r', '-z', '--name-only', rev]));
  }

  async untracked(): Promise<string[]> {
    return splitZ(await this.exec(['ls-files', '-z', '--others', '--exclude-standard']));
  }

  /**
   * Changed files between two revs, or a rev and the worktree (incl. untracked).
   * One diff call yields status, line counts and, against a commit, the new-side
   * blob; the worktree's blobs are hashed from disk.
   */
  async numstat(oldRev: string, newRev: string | 'worktree'): Promise<ChangedFile[]> {
    const range = newRev === 'worktree' ? [oldRev] : [oldRev, newRev];
    const [diff, untracked] = await Promise.all([
      this.exec(['diff', '-z', '-M', '--raw', '--no-abbrev', '--numstat', ...range]),
      newRev === 'worktree' ? this.untracked() : Promise.resolve([]),
    ]);
    const files = parseRawNumstat(diff);
    const known = new Set(files.map((f) => f.path));
    // `ls-files --others` lists a nested repository as `dir/`; git has no diff for it.
    const extra = await mapLimit(
      untracked.filter((p) => !known.has(p) && !p.endsWith('/')),
      READ_CONCURRENCY,
      async (path): Promise<ChangedFile> => {
        const file: ChangedFile = {
          path,
          status: 'A',
          additions: 0,
          deletions: 0,
          binary: false,
          blob: '',
          generated: false,
        };
        const st = await lstat(resolve(this.root, path)).catch(() => null);
        if (st?.isFile() && st.size >= BIG_FILE_THRESHOLD) return { ...file, binary: true };
        // Unreadable (permissions) counts as empty: one bad path must not fail the snapshot.
        const buf = (await this.readWorktree(path).catch(() => null)) ?? Buffer.alloc(0);
        file.binary = isBinary(buf);
        if (!file.binary) file.additions = countLines(buf);
        return file;
      },
    );
    const all = [...files, ...extra].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (newRev === 'worktree') await this.hashWorktree(all.filter((f) => f.status !== 'D'));
    return all;
  }

  /**
   * Sets `blob` to what git would store for each worktree entry: the file's
   * blob, a symlink's target blob, a submodule's checked-out commit. Regular
   * files go to one `hash-object --stdin-paths` call; everything else is hashed
   * on its own, so a gitlink, a broken link or an unreadable path never fails
   * the batch. A path containing a newline cannot ride the stdin list either.
   * A path that cannot be hashed keeps an empty blob.
   */
  private async hashWorktree(files: ChangedFile[]): Promise<void> {
    const regular: ChangedFile[] = [];
    await mapLimit(files, READ_CONCURRENCY, async (f) => {
      f.blob = '';
      if (f.submodule) {
        f.blob = await this.submoduleHead(f.path);
        return;
      }
      const st = await lstat(resolve(this.root, f.path)).catch(() => null);
      if (st?.isSymbolicLink()) f.blob = blobSha(Buffer.from(await readlink(resolve(this.root, f.path)), 'utf8'));
      else if (st?.isFile()) regular.push(f);
    });
    const batch = regular.filter((f) => !f.path.includes('\n'));
    const single = regular.filter((f) => f.path.includes('\n'));
    if (batch.length) {
      try {
        const out = await this.text(['hash-object', '--stdin-paths'], {
          input: batch.map((f) => f.path).join('\n') + '\n',
        });
        const shas = out.trim().split('\n');
        batch.forEach((f, i) => (f.blob = shas[i] ?? ''));
      } catch {
        // One unreadable path (permissions, vanished mid-refresh) aborts git's whole batch; retry each alone.
        single.push(...batch);
      }
    }
    await mapLimit(single, READ_CONCURRENCY, async (f) => {
      f.blob = await this.text(['hash-object', '--', f.path])
        .then((s) => s.trim())
        .catch(() => '');
    });
  }

  /** The commit a checked-out submodule is at, or '' if it is not a repository. */
  private async submoduleHead(path: string): Promise<string> {
    try {
      return (await execGit(resolve(this.root, path), ['rev-parse', '--verify', '--quiet', 'HEAD']))
        .toString('utf8')
        .trim();
    } catch {
      return '';
    }
  }

  /** Branches, tags, and recent commits for the mode picker. */
  async refs(): Promise<RefsResponse> {
    const [heads, remotes, tags, log, current, defaultBranch] = await Promise.all([
      this.text(['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']),
      this.text(['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/remotes']),
      this.text(['for-each-ref', '--format=%(refname:short)', '--sort=-creatordate', 'refs/tags']),
      // An unborn branch has no log; the picker still needs the refs.
      this.text(['log', '-n', '30', '--format=%H%x00%h%x00%s']).catch(() => ''),
      this.text(['rev-parse', '--abbrev-ref', 'HEAD'])
        .then((s) => s.trim())
        .catch(() => null),
      this.defaultBranch().catch(() => null),
    ]);
    const lines = (s: string) => s.split('\n').filter(Boolean);
    return {
      defaultBranch,
      current: current === 'HEAD' ? null : current,
      branches: lines(heads),
      // `origin/HEAD` shortens to `origin`; drop symbolic remote heads.
      remoteBranches: lines(remotes).filter((r) => r.includes('/') && !r.endsWith('/HEAD')),
      tags: lines(tags),
      recent: lines(log).map((l) => {
        const [sha = '', short = '', subject = ''] = l.split('\0');
        return { sha, short, subject };
      }),
    };
  }

  /**
   * Search the new side: a fixed string, or an extended regex with `regex`.
   * Case-sensitive unless `ignoreCase`; `word` matches whole words (vim's `*`).
   * Worktree searches include untracked files. The result is
   * bounded globally: git is stopped once `limit + 1` records have arrived, so a
   * common query in a large repository cannot flood the process. `paths`
   * restricts the search to those files; an empty list matches nothing.
   */
  async grep(
    query: string,
    rev: string | 'worktree',
    limit = 500,
    opts: { word?: boolean; ignoreCase?: boolean; regex?: boolean; paths?: string[] } = {},
  ): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
    // An explicit empty path list means "search nothing": with no pathspec git would search everything.
    if (!query || opts.paths?.length === 0) return { matches: [], truncated: false };
    // --no-column: `grep.column=true` would splice a column field into the -z record.
    const args = ['grep', '-n', '--no-column', '-I', opts.regex ? '-E' : '-F', '-z', `--max-count=${limit + 1}`];
    if (opts.word) args.push('-w');
    if (opts.ignoreCase) args.push('-i');
    args.push('-e', query);
    if (rev === 'worktree') args.push('--untracked');
    else args.push(rev);
    args.push('--');
    // Literal pathspecs: a path with `*` or `?` in it must not turn into a glob.
    for (const p of opts.paths ?? []) args.push(`:(literal)${p}`);
    // -z: "path\0line\0text\n" per match; with a rev the path is "rev:path".
    const records = await execGitRecords(this.root, args, limit + 1, { okCodes: [0, 1], timeoutMs: GREP_TIMEOUT_MS });
    const truncated = records.length > limit;
    const matches = records.slice(0, limit).map((rec) => {
      const [rawPath = '', line = '', ...rest] = rec.split('\0');
      const path = rev === 'worktree' ? rawPath : rawPath.slice(rawPath.indexOf(':') + 1);
      return { path, line: Number(line), text: rest.join('\0').slice(0, 300) };
    });
    return { matches, truncated };
  }

  /** Ignored files and directories (directories end with '/'). Feeds the watcher. */
  async ignoredPaths(): Promise<string[]> {
    return splitZ(await this.exec(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']));
  }

  /**
   * Raw `git diff` for one file. Untracked files diff against /dev/null; pass
   * `untracked` when the caller already knows, else an added file is probed.
   */
  async patch(
    oldRev: string,
    newRev: string | 'worktree',
    file: ChangedFile,
    context = 3,
    untracked?: boolean,
  ): Promise<string> {
    if (newRev === 'worktree' && file.status === 'A' && (untracked ?? !(await this.isTracked(file.path)))) {
      const out = await this.text(['diff', '--no-index', ...PATCH_ARGS, `-U${context}`, '--', '/dev/null', file.path], {
        okCodes: [0, 1],
      });
      // Normalize the a/ side so parsers see a conventional added-file header. Git
      // quotes each side on its own, so mirror the b/ side's quoting rather than assume none.
      return out.replace(
        /^diff --git "?a\/dev\/null"? ("?)b\/(.*)$/m,
        (_m, q: string, rest: string) => `diff --git ${q}a/${rest} ${q}b/${rest}`,
      );
    }
    const range = newRev === 'worktree' ? [oldRev] : [oldRev, newRev];
    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    return this.text(['diff', '-M', ...PATCH_ARGS, `-U${context}`, ...range, '--', ...paths]);
  }

  /** Patches for all changed files. Tracked files in one call; untracked appended. */
  async patchAll(oldRev: string, newRev: string | 'worktree', files: ChangedFile[], context = 3): Promise<string> {
    const range = newRev === 'worktree' ? [oldRev] : [oldRev, newRev];
    const tracked = this.text(['diff', '-M', ...PATCH_ARGS, `-U${context}`, ...range]);
    let untracked: ChangedFile[] = [];
    if (newRev === 'worktree') {
      const added = files.filter((f) => f.status === 'A' && !f.binary);
      if (added.length) {
        // The whole index rather than the added paths as arguments: a large diff would exceed argv.
        const known = new Set(await this.lsFiles());
        untracked = added.filter((f) => !known.has(f.path));
      }
    }
    const extras = await mapLimit(untracked, READ_CONCURRENCY, (f) => this.patch(oldRev, newRev, f, context, true));
    return [await tracked, ...extras].join('');
  }

  /**
   * Patches for `files` only: tracked ones in one call, worktree additions each on their own
   * (`patch` probes whether they are untracked). The caller bounds the batch, so the paths ride argv.
   */
  async patchMany(oldRev: string, newRev: string | 'worktree', files: ChangedFile[], context = 3): Promise<string> {
    const single = newRev === 'worktree' ? files.filter((f) => f.status === 'A') : [];
    const batched = files.filter((f) => !single.includes(f));
    const range = newRev === 'worktree' ? [oldRev] : [oldRev, newRev];
    const paths = batched.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
    const tracked = batched.length
      ? this.text(['diff', '-M', ...PATCH_ARGS, `-U${context}`, ...range, '--', ...paths])
      : Promise.resolve('');
    const extras = await mapLimit(single, READ_CONCURRENCY, (f) => this.patch(oldRev, newRev, f, context));
    return [await tracked, ...extras].join('');
  }

  private async isTracked(path: string): Promise<boolean> {
    const out = await this.exec(['ls-files', '-z', '--error-unmatch', '--', path], { okCodes: [0, 1] });
    return out.length > 0;
  }

  /**
   * Blob contents at rev, or null if absent or not a blob (a directory, a
   * gitlink). Rides the shared `cat-file --batch`, so hydrating every file of
   * a diff costs one process.
   */
  async show(rev: string, path: string): Promise<Buffer | null> {
    const o = await this.catFile.request(`${rev}:${path}`);
    return o?.type === 'blob' ? o.body : null;
  }

  /**
   * Worktree file at a repo-relative path, or null if absent or not a file.
   * A symlink yields its target string, which is what git stores for it, so a
   * link pointing outside the repository never exposes the target's contents.
   */
  async readWorktree(path: string): Promise<Buffer | null> {
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink()) return Buffer.from(await readlink(abs), 'utf8');
      if (!st.isFile()) return null;
      return await readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * First `bytes` of each blob, keyed by sha. One `cat-file --batch` answers
   * the whole list and only the prefix of each body is kept, so sniffing a
   * thousand changed files costs one process and a bounded amount of memory.
   * A sha that is not a blob (missing, a gitlink) is absent from the result.
   */
  async blobHeads(shas: string[], bytes: number): Promise<Map<string, Buffer>> {
    const objects = await Promise.all(shas.map((sha) => this.catFile.request(sha, bytes)));
    const out = new Map<string, Buffer>();
    objects.forEach((o, i) => {
      if (o?.type === 'blob') out.set(shas[i]!, o.body);
    });
    return out;
  }

  /**
   * First `bytes` of a file on the new side, or null if absent. The worktree
   * read is bounded at the file descriptor; a blob streams through the batch
   * reader, which keeps only the prefix.
   */
  async head(rev: string | 'worktree', path: string, bytes: number): Promise<Buffer | null> {
    if (rev !== 'worktree') {
      const o = await this.catFile.request(`${rev}:${path}`, bytes);
      return o?.type === 'blob' ? o.body : null;
    }
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    let fh;
    try {
      const st = await lstat(abs);
      if (!st.isFile()) return null;
      fh = await open(abs, 'r');
      const buf = Buffer.alloc(Math.min(bytes, st.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    } finally {
      await fh?.close();
    }
  }

  /** Paths git ignores, from a candidate list. */
  async ignored(paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const out = await this.exec(['check-ignore', '-z', '--stdin'], { input: paths.join('\0'), okCodes: [0, 1] });
    return new Set(splitZ(out));
  }
}

interface CatFileObject {
  type: string;
  size: number;
  /** The first `keep` bytes of the object. */
  body: Buffer;
}

interface CatFileRequest {
  keep: number;
  res: (o: CatFileObject | null) => void;
  rej: (e: Error) => void;
}

/**
 * One long-lived `git cat-file --batch` per repository. Object names go in on
 * stdin and come back in order on stdout, so a burst of reads (hydrating a
 * diff, sniffing every changed blob) costs one process instead of one each.
 * A body streams through the parser and only its first `keep` bytes are
 * retained. The child is unref'd and reaped after CAT_FILE_IDLE_MS idle, so it
 * never keeps the process alive or outlives a burst; the next request respawns
 * it. If it dies, every in-flight request rejects and the next one starts over.
 */
class CatFileBatch {
  private child: ChildProcess | null = null;
  private queue: CatFileRequest[] = [];
  private idle: NodeJS.Timeout | null = null;
  private header: Buffer[] = [];
  private cur: {
    req: CatFileRequest;
    type: string;
    size: number;
    remaining: number;
    kept: number;
    chunks: Buffer[];
  } | null = null;
  spawns = 0;

  constructor(private readonly cwd: string) {}

  /**
   * Resolves the object named by any `cat-file` object name (`sha`, `rev:path`),
   * or null when git reports it missing or ambiguous. A name with a newline
   * cannot ride the batch and is answered by one plain `cat-file` call.
   */
  request(name: string, keep = Infinity): Promise<CatFileObject | null> {
    if (name.includes('\n')) return this.single(name, keep);
    return new Promise((res, rej) => {
      const child = this.ensure();
      this.queue.push({ keep, res, rej });
      this.setRef(true);
      child.stdin!.write(`${name}\n`);
    });
  }

  private async single(name: string, keep: number): Promise<CatFileObject | null> {
    const type = (await execGit(this.cwd, ['cat-file', '-t', name]).catch(() => null))?.toString('utf8').trim();
    if (!type) return null;
    const body = await execGit(this.cwd, ['cat-file', type, name]);
    return { type, size: body.length, body: body.subarray(0, Math.min(body.length, keep)) };
  }

  private ensure(): ChildProcess {
    if (this.child) return this.child;
    const args = ['cat-file', '--batch'];
    const child = spawn('git', [...CONFIG_ARGS, ...args], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    this.spawns++;
    const err: Buffer[] = [];
    child.stdout!.on('data', (c: Buffer) => this.onData(child, c));
    child.stderr!.on('data', (c: Buffer) => err.push(c));
    // EPIPE on a write after the child died surfaces through `close`, not here.
    child.stdin!.on('error', () => {});
    child.on('error', (e) =>
      this.reset(child, new GitError(`git ${args.join(' ')} failed: ${e.message}`, args, null, '')),
    );
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      this.reset(child, new GitError(`git ${args.join(' ')} exited (${code}): ${stderr.trim()}`, args, code, stderr));
    });
    this.child = child;
    return child;
  }

  /**
   * Output per name: `<sha> <type> <size>\n<body>\n`, or `<name> missing\n`
   * (also `ambiguous`). Answers arrive in request order.
   */
  private onData(child: ChildProcess, chunk: Buffer): void {
    if (child !== this.child) return;
    let off = 0;
    while (off < chunk.length) {
      if (this.cur == null) {
        const nl = chunk.indexOf(10, off);
        if (nl === -1) {
          this.header.push(chunk.subarray(off));
          return;
        }
        this.header.push(chunk.subarray(off, nl));
        const fields = Buffer.concat(this.header).toString('utf8').split(' ');
        this.header = [];
        off = nl + 1;
        const req = this.queue.shift();
        if (!req) {
          this.reset(child, new GitError('git cat-file --batch: unexpected output', ['cat-file', '--batch'], null, ''));
          child.kill();
          return;
        }
        // A miss echoes the request name, which may itself contain spaces
        // (`HEAD:no such.txt missing`); a hit is always `<sha> <type> <size>`.
        const tail = fields[fields.length - 1];
        if (tail === 'missing' || tail === 'ambiguous' || fields.length < 3) {
          req.res(null);
          this.settle();
          continue;
        }
        const size = Number(fields[2]);
        this.cur = { req, type: fields[1]!, size, remaining: size + 1, kept: 0, chunks: [] };
      }
      const cur = this.cur;
      const take = Math.min(cur.remaining, chunk.length - off);
      const want = Math.min(take, Math.min(cur.req.keep, cur.size) - cur.kept);
      if (want > 0) {
        cur.chunks.push(chunk.subarray(off, off + want));
        cur.kept += want;
      }
      cur.remaining -= take;
      off += take;
      if (cur.remaining === 0) {
        this.cur = null;
        cur.req.res({ type: cur.type, size: cur.size, body: Buffer.concat(cur.chunks) });
        this.settle();
      }
    }
  }

  /** Nothing in flight: let the process exit on its own and reap the child if it stays idle. */
  private settle(): void {
    if (this.queue.length > 0 || !this.child) return;
    this.setRef(false);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), CAT_FILE_IDLE_MS);
    this.idle.unref();
  }

  private stop(): void {
    const child = this.child;
    if (!child || this.queue.length > 0) return;
    this.child = null;
    child.stdin!.end();
  }

  private reset(child: ChildProcess, err: GitError): void {
    if (child !== this.child) return;
    this.child = null;
    this.cur = null;
    this.header = [];
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    for (const req of this.queue.splice(0)) req.rej(err);
  }

  private setRef(on: boolean): void {
    const child = this.child;
    if (!child) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    // Pipes are net.Sockets and hold the loop like the child handle does.
    for (const h of [child, child.stdin, child.stdout, child.stderr] as ({
      ref(): unknown;
      unref(): unknown;
    } | null)[]) {
      if (on) h?.ref();
      else h?.unref();
    }
  }
}

function execGit(cwd: string, args: string[], opts: ExecOptions = {}): Promise<Buffer> {
  return new Promise((res, rej) => {
    const child = execFile(
      'git',
      [...CONFIG_ARGS, ...args],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...opts.env } },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code ?? null) : 0;
        if (err && !(typeof code === 'number' && opts.okCodes?.includes(code))) {
          rej(
            new GitError(
              `git ${args.join(' ')} failed: ${stderr.toString('utf8').trim() || err.message}`,
              args,
              typeof code === 'number' ? code : null,
              stderr.toString('utf8'),
            ),
          );
          return;
        }
        res(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/**
 * Runs git and collects newline-terminated records, killing the child once
 * `maxRecords` have arrived. Streams instead of buffering so the bound holds at
 * the process boundary, not after the fact.
 */
function execGitRecords(cwd: string, args: string[], maxRecords: number, opts: RecordOptions = {}): Promise<string[]> {
  return new Promise((res, rej) => {
    const child = spawn('git', [...CONFIG_ARGS, ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let seen = 0;
    let done = false;
    let timedOut = false;
    const timer =
      opts.timeoutMs == null
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        if (++seen === maxRecords) {
          chunks.push(chunk.subarray(0, i + 1));
          done = true;
          child.kill();
          return;
        }
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.on('error', (err) => rej(new GitError(`git ${args.join(' ')} failed: ${err.message}`, args, null, '')));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        rej(new GitError(`git ${args.join(' ')} timed out after ${opts.timeoutMs}ms`, args, null, ''));
        return;
      }
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (!done && code !== 0 && !(code != null && opts.okCodes?.includes(code))) {
        rej(new GitError(`git ${args.join(' ')} failed: ${stderr.trim()}`, args, code, stderr));
        return;
      }
      const records = Buffer.concat(chunks).toString('utf8').split('\n');
      if (records[records.length - 1] === '') records.pop();
      res(records);
    });
  });
}

function splitZ(buf: Buffer): string[] {
  const s = buf.toString('utf8');
  if (s.length === 0) return [];
  const parts = s.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * `-z -M --raw --no-abbrev --numstat`: the raw records come first, then the numstat records,
 * each path-terminated by NUL. Raw: ":mode mode sha sha X\0path\0", renames and
 * copies "R100\0old\0new\0". Numstat: "add\tdel\tpath\0", renames "add\tdel\t\0old\0new\0".
 * Binary files count as "-\t-". The dst sha is the new-side blob against a
 * commit; against the worktree it is zeros and the caller hashes the file.
 * Mode 160000 on either side marks a gitlink, which no file operation may touch.
 */
function parseRawNumstat(buf: Buffer): ChangedFile[] {
  const parts = splitZ(buf);
  const byPath = new Map<string, ChangedFile>();
  let i = 0;
  for (; i < parts.length && parts[i]!.startsWith(':'); i++) {
    const [srcMode = '', dstMode = '', , dstSha = '', code = ''] = parts[i]!.split(' ');
    const status = code[0] as ChangeStatus;
    const oldPath = status === 'R' || status === 'C' ? parts[++i]! : undefined;
    const path = parts[++i]!;
    const file: ChangedFile = {
      path,
      status,
      additions: 0,
      deletions: 0,
      binary: false,
      blob: /^0+$/.test(dstSha) ? '' : dstSha,
      generated: false,
    };
    if (oldPath != null) file.oldPath = oldPath;
    if (dstMode === '160000' || (status === 'D' && srcMode.slice(1) === '160000')) file.submodule = true;
    byPath.set(path, file);
  }
  for (; i < parts.length; i++) {
    const [add = '', del = '', inline] = parts[i]!.split('\t');
    let path = inline;
    if (!path) {
      i += 2;
      path = parts[i]!;
    }
    const file = byPath.get(path);
    if (!file) continue;
    file.binary = add === '-';
    if (!file.binary) {
      file.additions = Number(add);
      file.deletions = Number(del);
    }
  }
  return [...byPath.values()];
}

/** The sha git gives a blob with these contents; what `hash-object --stdin` prints. */
function blobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  if (buf[buf.length - 1] !== 10) n++;
  return n;
}
