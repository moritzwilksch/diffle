// Pure shaping of a `textDocument/hover` result into one markdown string.

/** The three shapes LSP allows for hover contents, oldest first. */
export type MarkedString = string | { language: string; value: string };
export type HoverContents = MarkedString | MarkedString[] | { kind: 'markdown' | 'plaintext'; value: string };

/**
 * One markdown document for the tooltip, or null when the server sent nothing
 * worth showing. Plaintext and `{language, value}` parts become fenced blocks,
 * so their text is never re-read as markdown.
 */
export function hoverMarkdown(contents: HoverContents | null | undefined): string | null {
  if (contents == null) return null;
  const parts = (Array.isArray(contents) ? contents : [contents]).map(partMarkdown).filter((p) => p.trim() !== '');
  return parts.length ? parts.join('\n\n') : null;
}

function partMarkdown(part: MarkedString | { kind: 'markdown' | 'plaintext'; value: string }): string {
  if (typeof part === 'string') return part;
  if ('kind' in part) return part.kind === 'markdown' ? part.value : fence(part.value, '');
  return fence(part.value, part.language);
}

/** A fence long enough that a backtick run inside the code cannot close it early. */
function fence(code: string, lang: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${code.replace(/\n$/, '')}\n${ticks}`;
}

/** An inline markdown link whose target is a `file:` URI, as pyright and pyrefly write "Go to X". */
const fileLink = () => /\[([^\]]*)\]\(\s*<?(file:[^\s)>]+)>?\s*\)/g;

/** The `file:` URIs the hover text links to, each once. */
export function fileLinkUris(md: string): string[] {
  return [...new Set([...md.matchAll(fileLink())].map((m) => m[2]!))];
}

/**
 * Rewrites the hover text's `file:` links to `diffle:<path>#L<line>`, which the client follows as an
 * in-app jump. `resolved` maps each URI to its repo-relative path and line; a URI it omits lies
 * outside the repository and becomes plain text, since opening a browser tab on a source file is
 * never what the reader wants.
 */
export function localizeFileLinks(md: string, resolved: Map<string, { path: string; line?: number }>): string {
  return md.replace(fileLink(), (_m, label: string, uri: string) => {
    const loc = resolved.get(uri);
    if (!loc) return label;
    return `[${label}](diffle:${encodeURI(loc.path)}${loc.line != null ? `#L${loc.line}` : ''})`;
  });
}
