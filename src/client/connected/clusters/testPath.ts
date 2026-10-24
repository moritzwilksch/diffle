/** Directory names that hold tests or their inputs, wherever they sit in the path. */
const TEST_DIRS = new Set(['tests', 'test', '__tests__', 'e2e', 'fixtures', 'testdata']);

/** File-name conventions of the languages the graph sees: `*.test.*`, `*_test.go`, `test_*.py`, Rust's `tests.rs`. */
const TEST_NAMES: readonly RegExp[] = [
  /^.+\.(test|spec)\..+$/,
  /^.+_test\..+$/,
  /^.+_tests\.rs$/,
  /^tests\.rs$/,
  /^test_.+\.py$/,
  /^.+_test\.go$/,
];

/** Whether `path` (with `/` separators) is a test file or sits in a test directory; case does not matter. */
export function isTestPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments[segments.length - 1] ?? '';
  return segments.some((s) => TEST_DIRS.has(s)) || TEST_NAMES.some((re) => re.test(name));
}
