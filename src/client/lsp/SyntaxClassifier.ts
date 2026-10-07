import type { Grammar } from 'shiki/core';

/** A TextMate rule stack; `null` is the start of a file. */
type State = Parameters<Grammar['tokenizeLine']>[1];

/** Lines between saved tokenizer states: a later query re-tokenizes at most this many. */
const STEP = 100;
/** Tokenizing time per slice before yielding, so newer queries and the budget timer get a turn. */
const SLICE_MS = 16;
/** Per-query wait; tokenizing continues past it, so a later query finds the answer ready. */
const BUDGET_MS = 300;
/**
 * Longer lines keep the state unchanged, as the viewer's highlighter treats them. A TextMate time
 * limit would instead cut lines short while the regex engine compiles a fresh grammar.
 */
const MAX_LINE = 1000;

/** Scopes inside a string that name code: interpolations and embedded expressions. */
const CODE = /^(meta\.embedded|meta\.template\.expression|meta\.interpolation|source\.|variable|entity\.name)/;
/** Scopes of literal text. */
const PROSE = /^(string|meta\.jsx\.children)/;
/** Scopes of keywords, and of some type names. */
const WORDS = /^(keyword|storage)/;
/**
 * Grammars also scope names as `storage` or `keyword`: types (`int`, `string`, Java's `String`) and
 * Ruby's keyword-like methods (`new`, `include`, `attr_reader`). Keywords are never capitalized.
 */
const NAMES =
  /^(storage\.type\.(primitive|built-in|numeric|string|generic)|keyword\.(other\.)?type\b|keyword\.other\.special-method\.ruby)/;

/** Scopes run outermost first, as TextMate reports them. Comments win; otherwise the innermost match decides. */
function blocksScopes(scopes: readonly string[], word: string): boolean {
  if (scopes.some((scope) => scope.startsWith('comment'))) return true;
  // The first scope is the file's own `source.*`; only nested ones mark embedded code.
  for (let i = scopes.length - 1; i > 0; i--) {
    const scope = scopes[i]!;
    if (CODE.test(scope)) return false;
    if (PROSE.test(scope)) return true;
    if (WORDS.test(scope)) return !NAMES.test(scope) && !/^\p{Lu}/u.test(word);
  }
  return false;
}

interface Entry {
  contents: string;
  lang: string;
  grammar: Grammar;
  lines: string[];
  /** `states[k]` is the tokenizer state before line `k * STEP`, 0-based. */
  states: State[];
  /** The background run's position: the state before line `row`. */
  row: number;
  state: State;
  /** The checkpoint the background run tokenizes up to; -1 stops a dropped entry's run. */
  target: number;
  /** Settles when `states` reaches `target`; null while idle. */
  run: Promise<void> | null;
}

function advance(entry: Entry, row: number, state: State): State {
  const text = entry.lines[row]!;
  return text.length > MAX_LINE ? state : entry.grammar.tokenizeLine(text, state).ruleStack;
}

/** Saves checkpoints up to `entry.target`, yielding between slices. */
async function tokenize(entry: Entry): Promise<void> {
  while (entry.states.length <= entry.target) {
    // Checked per line: a fresh grammar compiles its regexes on first use, slowing early lines.
    const until = performance.now() + SLICE_MS;
    while (entry.states.length <= entry.target && performance.now() < until) {
      entry.state = advance(entry, entry.row++, entry.state);
      if (entry.row % STEP === 0) entry.states.push(entry.state);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  entry.run = null;
}

/** Advances `state` from line `from` to `to`, yielding between slices; undefined once `deadline` passes. */
async function walk(
  entry: Entry,
  from: number,
  to: number,
  state: State,
  deadline: number,
): Promise<State | undefined> {
  let row = from;
  while (row < to) {
    if (performance.now() >= deadline) return undefined;
    const until = Math.min(performance.now() + SLICE_MS, deadline);
    while (row < to && performance.now() < until) state = advance(entry, row++, state);
    if (row < to) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return state;
}

/** Bounded per-file cache of TextMate states, tokenized in slices so a query can give up while tokenizing continues. */
export class SyntaxClassifier {
  private entries = new Map<string, Entry>();
  constructor(private load: (lang: string) => Grammar) {}

  /** Positions use 1-based lines and UTF-16 columns. Undecided within the budget means not blocked. */
  async blocked(key: string, lang: string, contents: string, line: number, col: number): Promise<boolean> {
    if (contents.length > 1_000_000 || line < 1 || col < 0) return false;
    const entry = this.entry(key, lang, contents);
    const row = line - 1;
    const text = entry.lines[row];
    if (text == null || col >= text.length || text.length > MAX_LINE) return false;
    const k = Math.floor(row / STEP);
    const deadline = performance.now() + BUDGET_MS;
    if (entry.states.length <= k) {
      entry.target = Math.max(entry.target, k);
      entry.run ??= tokenize(entry);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const lapse = new Promise((resolve) => (timer = setTimeout(resolve, BUDGET_MS)));
      await Promise.race([entry.run, lapse]);
      clearTimeout(timer);
      if (entry.states.length <= k) return false;
    }
    // The lines past the checkpoint share the budget: pathological lines can take far longer than a slice.
    const state = await walk(entry, k * STEP, row, entry.states[k]!, deadline);
    if (state === undefined) return false;
    const token = entry.grammar.tokenizeLine(text, state).tokens.find((t) => col < t.endIndex);
    return token ? blocksScopes(token.scopes, text.slice(token.startIndex, token.endIndex)) : false;
  }

  private entry(key: string, lang: string, contents: string): Entry {
    const cached = this.entries.get(key);
    if (cached?.contents === contents && cached.lang === lang) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const grammar = this.load(lang);
    if (cached) this.drop(key, cached);
    const lines = contents.split('\n');
    const entry: Entry = { contents, lang, grammar, lines, states: [null], row: 0, state: null, target: 0, run: null };
    this.entries.set(key, entry);
    for (const [first, oldest] of this.entries) {
      if (this.entries.size <= 8 && this.size() <= 4_000_000) break;
      this.drop(first, oldest);
    }
    return entry;
  }

  private drop(key: string, entry: Entry): void {
    entry.target = -1;
    this.entries.delete(key);
  }

  private size(): number {
    return [...this.entries.values()].reduce((n, entry) => n + entry.contents.length, 0);
  }
}
