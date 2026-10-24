import type { Focus } from './focus.js';

// The words of the Connected scope, kept apart from the markup so they can be tested and kept consistent:
// "cluster" for a group of changed files, "callers" for the unchanged files that call into one.

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What each bucket holds; the row's title, and shown under the list while the bucket is focused. */
export const BUCKET_HINT = {
  unlinked: 'Unlinked: code files no other changed file references.',
  other: 'Other: files no language server could graph (no server, binary, deleted, generated).',
} as const;

/** Seconds of analysis before the status shows a timer. */
const ELAPSED_AFTER_MS = 3000;

/** The timer suffix of "Analyzing references…": empty at first, then whole seconds, so a slow build shows progress. */
export function elapsedLabel(ms: number): string {
  return ms < ELAPSED_AFTER_MS ? '' : `${Math.floor(ms / 1000)} s`;
}

/**
 * The hover text of "+ context": what it lists (the server caps the list), or why it cannot. `withKey` names
 * the shortcut; the graph dialog leaves it out, because the keymap is silent while the dialog is open.
 */
export function contextToggleTitle(focus: Focus | null, listed: number, total: number, withKey = true): string {
  if (focus?.kind !== 'cluster') return 'Only a cluster lists unchanged callers';
  if (total === 0) return 'This cluster has no unchanged callers to list';
  const key = withKey ? ' (gc)' : '';
  if (listed < total) return `List ${listed} of ${total} unchanged files that call into this cluster${key}`;
  return total === 1
    ? `List the unchanged file that calls into this cluster${key}`
    : `List the ${total} unchanged files that call into this cluster${key}`;
}

/** The graph dialog's title; the cluster's label follows it. */
export const GRAPH_TITLE = 'Connected files';

/** The hover text of the Graph button: what it opens, or why it cannot. */
export function graphButtonTitle(focus: Focus | null): string {
  if (focus?.kind !== 'cluster') return 'Pick a cluster: only linked files can be drawn';
  return 'Show how this cluster’s files connect (gm)';
}

/** The dialog's counts line: what the cluster holds, and its unchanged callers whether or not they are drawn. */
export function graphCounts(n: {
  files: number;
  links: number;
  callers: number;
  callersDrawn: boolean;
  /** Test files `Hide tests` leaves out of the drawing. */
  testsHidden: number;
}): string {
  const parts = [plural(n.files, 'file'), plural(n.links, 'link')];
  if (n.callers > 0) parts.push(`${plural(n.callers, 'unchanged caller')}${n.callersDrawn ? '' : ' (hidden)'}`);
  if (n.testsHidden > 0) parts.push(`${plural(n.testsHidden, 'test')} hidden`);
  return parts.join(' · ');
}

/** Symbols an arrow's sentence names before the rest fold into a count. */
const SENTENCE_SYMBOLS = 3;

/** The file's name without its directory, or its last two segments when `other` would read the same. */
function shortPath(path: string, other: string): string {
  const parts = path.split('/');
  const name = parts[parts.length - 1]!;
  return name === other.slice(other.lastIndexOf('/') + 1) && parts.length > 1 ? parts.slice(-2).join('/') : name;
}

/** An arrow in words: "facts_tests.rs uses UnitFacts and UnitArea from facts.rs", the symbols beyond three counted. */
export function arrowSentence(e: {
  from: string;
  to: string;
  uses: readonly { symbol: string }[];
  /** Used symbols before the server's cap. */
  total: number;
}): string {
  const from = shortPath(e.from, e.to);
  const to = shortPath(e.to, e.from);
  const named = e.uses.slice(0, SENTENCE_SYMBOLS).map((u) => u.symbol);
  if (named.length === 0) return `${from} uses ${to}`;
  const rest = e.total - named.length;
  const items = rest > 0 ? [...named, `${rest} more`] : named;
  const list = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return `${from} uses ${list} from ${to}`;
}

/** The side panel's reading guide while nothing is selected. */
export const GRAPH_HOW_TO = [
  'An arrow points from a file to a file it uses.',
  'Click, or press Space, to select a file or an arrow.',
  'Enter, or a double-click, opens a file in the review.',
  'The legend is at the bottom left.',
] as const;

/** Whether `Hide tests` has anything to act on in a cluster of `files` files with `tests` tests, and its hover text. */
export function hideTestsTitle(tests: number, files: number, hidden: boolean): { usable: boolean; title: string } {
  if (tests === 0) return { usable: false, title: 'This cluster has no test files to hide' };
  if (tests >= files)
    return { usable: false, title: 'Every file of this cluster is a test, so hiding them would leave nothing' };
  const named = plural(tests, 'test file');
  return { usable: true, title: hidden ? `Show the ${named} again` : `Hide the ${named}` };
}
