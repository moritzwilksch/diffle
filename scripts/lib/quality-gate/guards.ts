import { posix } from 'node:path';

export const LOC_CAP = 330;
export const FOLDER_CAP = 15;

const SOURCE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'rs']);
const MANIFESTS = new Set(['package.json', 'Cargo.toml']);
/** Rust keeps unit tests inline: everything from the first `#[cfg(test)]` line on is the test module. */
const RUST_TESTS = /^#\[cfg\(test\)\]/m;
const GENERATED = [
  /\.(gen\.tsx?|min\.js|min\.css|d\.ts)$/,
  /_generated\.|\.generated\./,
  /(^|\/)(node_modules|dist|build|generated)\//,
];
/** Tests, their fixtures and their snapshots are neither size-checked nor counted toward a folder. */
const TEST_PATH = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test|tests|__tests__|e2e|testdata|fixtures|__snapshots__)\//;

export interface TreeFile {
  path: string;
  /** Lines in the file; 0 when `isChecked` says the path is not size-checked. */
  lines: number;
}

export interface GateInput {
  /** Every file the commit would contain: tracked, modified and new, but not git-ignored. */
  files: readonly TreeFile[];
  ignore: { files: readonly string[]; folders: readonly string[] };
}

export type Finding = { guard: 'size'; path: string; lines: number } | { guard: 'folder'; dir: string; count: number };

/** Lines the size cap judges: all of them, but none of a Rust file's trailing test module. */
export function countLines(path: string, content: string): number {
  const counted = posix.extname(path) === '.rs' ? content.split(RUST_TESTS)[0]! : content;
  return counted.split('\n').length - 1;
}

export function isSource(path: string): boolean {
  return SOURCE_EXTENSIONS.has(posix.extname(path).slice(1));
}

export function isGenerated(path: string): boolean {
  return GENERATED.some((pattern) => pattern.test(path));
}

export function isTest(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Hand-written, non-test source: the only files the size and folder caps apply to. */
export function isChecked(path: string): boolean {
  return isSource(path) && !isGenerated(path) && !isTest(path);
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** A pattern without `/` matches the basename at any depth, one with `/` the whole path; `*` spans `/`. */
export function matchesIgnore(target: string, patterns: readonly string[]): boolean {
  const base = posix.basename(target);
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern);
    return pattern.includes('/') ? re.test(target) || re.test(`${target}/`) : re.test(base);
  });
}

function sizeFindings({ files, ignore }: GateInput): Finding[] {
  return files
    .filter(({ path, lines }) => lines > LOC_CAP && !matchesIgnore(path, ignore.files))
    .map(({ path, lines }) => ({ guard: 'size', path, lines }));
}

/** A package root keeps its manifest beside its sources, so its file count says nothing about cohesion. */
function folderFindings({ files, ignore }: GateInput): Finding[] {
  const packageRoots = new Set(
    files.filter(({ path }) => MANIFESTS.has(posix.basename(path))).map(({ path }) => posix.dirname(path)),
  );
  const counts = new Map<string, number>();
  for (const { path } of files) {
    if (!isChecked(path)) continue;
    const dir = posix.dirname(path);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .filter(([dir, count]) => count > FOLDER_CAP && !packageRoots.has(dir) && !matchesIgnore(dir, ignore.folders))
    .map(([dir, count]) => ({ guard: 'folder', dir, count }));
}

/** Every checked file stays within the line cap and every folder within the file cap, unless an ignore file lists it. */
export function checkGate(input: GateInput): Finding[] {
  return [...sizeFindings(input), ...folderFindings(input)];
}
