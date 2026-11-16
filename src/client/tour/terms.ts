import { primitive } from './document.js';

/**
 * Where a tour's terms show their definitions: each `diffle-term` where the prose defines it, and
 * again at the term's first use in each later section, so a reader who jumps in still gets it.
 */

/** A term's use in a text node that shows its definition: the matched words and what they mean. */
export interface TermUse {
  start: number;
  end: number;
  def: string;
}

/** Text in these names no term: code, headings, controls, a drawing. `crates/diffle/src/tour/blocks/term.rs` skips the same. */
const PLAIN = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'code',
  'pre',
  'a',
  'svg',
  'diffle-code',
  'diffle-symbol',
  'diffle-jump',
  'diffle-term',
]);

/** A term as matched: its text, whitespace collapsed, lower-cased. */
function termKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** `key` as a whole word or words, any case, any whitespace between its words. */
function pattern(key: string): RegExp {
  const words = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${words}(?![\\p{L}\\p{N}_])`, 'iu');
}

/** Each document's repeated term uses by text node, read once. */
const read = new WeakMap<Element, Map<Text, TermUse[]>>();

/** The term uses in `text`, a text node of a tour document, that show a definition again. */
export function termUses(text: Text): TermUse[] | undefined {
  const body = text.ownerDocument.body;
  let uses = read.get(body);
  if (!uses) {
    uses = repeats(body);
    read.set(body, uses);
  }
  return uses.get(text);
}

/** Walks `body` in order: a term's definition marks its section, and its first use in each later one repeats it. */
function repeats(body: Element): Map<Text, TermUse[]> {
  const uses = new Map<Text, TermUse[]>();
  const defs = new Map<string, { def: string; pattern: RegExp }>();
  /** Each term's last section showing its definition. */
  const shown = new Map<string, number>();
  let section = 0;
  const mark = (text: Text) => {
    const found: TermUse[] = [];
    for (const [key, { def, pattern }] of defs) {
      if (shown.get(key) === section) continue;
      const match = pattern.exec(text.data);
      if (!match) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (found.some((u) => u.start < end && start < u.end)) continue;
      found.push({ start, end, def });
      shown.set(key, section);
    }
    if (found.length)
      uses.set(
        text,
        found.sort((a, b) => a.start - b.start),
      );
  };
  const visit = (node: Node, top: boolean) => {
    if (node instanceof Text) return mark(node);
    if (!(node instanceof Element)) return;
    if (top && node.localName === 'h2') section++;
    const element = primitive(node);
    if (element?.tag === 'diffle-term') {
      const key = termKey(node.textContent ?? '');
      if (key && !defs.has(key)) defs.set(key, { def: element.def, pattern: pattern(key) });
      shown.set(key, section);
    }
    if (PLAIN.has(node.localName)) return;
    for (const child of node.childNodes) visit(child, false);
  };
  for (const child of body.childNodes) visit(child, true);
  return uses;
}
