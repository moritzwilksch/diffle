import { isSupportedLanguage, type Lang, LiveTokenizer, type Theme, tokenNames } from '@pierre/highlights';

/** Longer lines are left alone, as the viewer leaves them unhighlighted. */
const MAX_LINE = 1000;
/** Literal text: comments and their doc tags, strings (a Ruby symbol names code), JSX text. */
const LITERAL = /^(comment|string(?!\.special\.symbol)|text\.jsx)|\.jsdoc$/;
/** Token names only, so no colors are needed. */
const NO_COLORS: Theme = { name: 'none', appearance: 'dark', style: {} };

/**
 * Lexers name types `type.*` and keyword-like methods `function`, so a keyword token is a keyword.
 * Python's lexer marks an f-string's `{` but leaves the expression after it a string.
 */
function blocksToken(name: string, previous: { name: string; text: string } | null): boolean {
  if (name === 'string' && previous?.name === 'punctuation.special' && previous.text.endsWith('{')) return false;
  return LITERAL.test(name) || name.startsWith('keyword');
}

interface Entry {
  contents: string;
  lang: Lang;
  tokenizer: LiveTokenizer;
}

/** Bounded per-file cache of tokenized documents, each lexed in full on first query. */
export class SyntaxClassifier {
  private entries = new Map<string, Entry>();

  /** Positions use 1-based lines and UTF-16 columns. A language without a lexer is never blocked. */
  blocked(key: string, lang: string, contents: string, line: number, col: number): boolean {
    if (contents.length > 1_000_000 || line < 1 || col < 0 || !isSupportedLanguage(lang)) return false;
    const { tokenizer } = this.entry(key, lang, contents);
    const row = line - 1;
    if (row >= tokenizer.lineCount) return false;
    const text = tokenizer.getLineText(row);
    if (col >= text.length || text.length > MAX_LINE) return false;
    // Records are `(tokenId << 24) | end` words, or `[end, tokenId]` pairs on very long lines.
    const { format, data } = tokenizer.getLineRecords(row);
    const wide = format === 'wide32';
    let previous: { name: string; text: string } | null = null;
    let start = 0;
    for (let i = 0; i < (wide ? data.length / 2 : data.length); i++) {
      const end = wide ? data[2 * i]! : data[i]! & 0xffffff;
      const name = tokenNames[wide ? data[2 * i + 1]! : data[i]! >>> 24] ?? '';
      if (col < end) return blocksToken(name, previous);
      previous = { name, text: text.slice(start, end) };
      start = end;
    }
    return false;
  }

  private entry(key: string, lang: Lang, contents: string): Entry {
    const cached = this.entries.get(key);
    if (cached?.contents === contents && cached.lang === lang) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    if (cached) this.drop(key, cached);
    const entry: Entry = { contents, lang, tokenizer: new LiveTokenizer({ lang, theme: NO_COLORS, code: contents }) };
    this.entries.set(key, entry);
    for (const [first, oldest] of this.entries) {
      if (this.entries.size <= 8 && this.size() <= 4_000_000) break;
      this.drop(first, oldest);
    }
    return entry;
  }

  private drop(key: string, entry: Entry): void {
    entry.tokenizer.dispose();
    this.entries.delete(key);
  }

  private size(): number {
    return [...this.entries.values()].reduce((n, entry) => n + entry.contents.length, 0);
  }
}
