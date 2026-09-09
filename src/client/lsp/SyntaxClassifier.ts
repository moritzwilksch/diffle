import type { Parser, Node, Tree } from 'web-tree-sitter';

const STRINGS = new Set([
  'string',
  'string_literal',
  'raw_string_literal',
  'interpreted_string_literal',
  'char_literal',
  'character_literal',
  'character',
  'template_string',
  'string_content',
  'string_fragment',
  'encapsed_string',
  'heredoc',
  'heredoc_body',
  'nowdoc',
  'simple_string_literal',
  'multi_line_string_literal',
  'line_string_literal',
  'multiline_string',
  'raw_string',
  'quoted_string',
  'regex',
  'regex_literal',
  'jsx_text',
]);
const EXPRESSIONS = new Set([
  'interpolation',
  'template_substitution',
  'string_interpolation',
  'interpolated_expression',
  'embedded_expression',
  'command_substitution',
  'arithmetic_expansion',
  'expansion',
  'variable_name',
]);

/** Reject grammar keyword tokens and literal text, but allow interpolated expressions. */
export function blocksNode(node: Node | null): boolean {
  // Grammars distinguish anonymous keyword tokens from named identifiers, even for the same spelling.
  if (node && !node.isNamed && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(node.type)) return true;
  for (; node; node = node.parent) {
    if (node.type.includes('comment') || STRINGS.has(node.type)) return true;
    if (EXPRESSIONS.has(node.type)) return false;
  }
  return false;
}

/** Worker-owned, bounded tree cache. Replaced and evicted WASM trees are freed explicitly. */
export class SyntaxClassifier {
  private entries = new Map<string, { contents: string; grammar: string; tree: Tree }>();
  constructor(private load: (grammar: string) => Promise<Parser>) {}

  async blocked(key: string, grammar: string, contents: string, line: number, col: number): Promise<boolean> {
    if (contents.length > 1_000_000 || line < 1 || col < 0) return false;
    let entry = this.entries.get(key);
    if (!entry || entry.contents !== contents || entry.grammar !== grammar) {
      const parser = await this.load(grammar);
      let tree: Tree | null;
      try {
        tree = parser.parse(contents);
      } finally {
        parser.delete();
      }
      if (!tree) return false;
      entry?.tree.delete();
      entry = { contents, grammar, tree };
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > 8 || this.size() > 4_000_000) {
      const first = this.entries.keys().next().value!;
      this.entries.get(first)!.tree.delete();
      this.entries.delete(first);
    }
    // web-tree-sitter's JS binding uses UTF-16 indices and columns, not UTF-8 bytes.
    const point = { row: line - 1, column: col };
    const node = entry.tree.rootNode.descendantForPosition(point);
    if (
      !node ||
      node.endPosition.row < point.row ||
      (node.endPosition.row === point.row && node.endPosition.column <= col)
    )
      return false;
    return blocksNode(node);
  }

  private size(): number {
    return [...this.entries.values()].reduce((n, entry) => n + entry.contents.length, 0);
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.tree.delete();
    this.entries.clear();
  }
}
