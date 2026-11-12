import type { SupportedLanguages } from '@pierre/diffs';
import { type ReactNode, useEffect, useState } from 'react';
import { highlightCode } from '@/client/lsp/highlight.js';
import { useStore } from '@/client/store.js';

/** One line of a diagram's code: its `tspan`'s position, and its text. */
export interface CodeLine {
  at: Record<string, string | undefined>;
  text: string;
}

/**
 * A diagram's `text class="code"`: its lines, one `tspan` each, coloured token by token as the
 * highlighter colours `lang` in the diff; plain until it answers.
 */
export function DiagramCode({ props, lines, lang }: { props: object; lines: CodeLine[]; lang: string }): ReactNode {
  const rows = useTokens(
    lines.map((l) => l.text),
    lang,
  );
  return (
    <text {...props}>
      {lines.map((line, i) => (
        <tspan key={i} {...line.at}>
          {rows?.[i]
            ? rows[i].map((t, j) => (
                <tspan key={j} style={t.color ? { fill: t.color } : undefined}>
                  {t.text}
                </tspan>
              ))
            : line.text}
        </tspan>
      ))}
    </text>
  );
}

/** A run of code in one colour: a CSS colour, which may name both themes' with `light-dark()`. */
interface Token {
  text: string;
  color?: string;
}

/** `lines` of `lang`, coloured token by token as the diff colours them; null until known. */
function useTokens(lines: readonly string[], lang: string): Token[][] | null {
  const theme = useStore((s) => s.theme);
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const source = lines.join('\n');
  useEffect(() => {
    let live = true;
    highlightCode(source.split('\n'), lang as SupportedLanguages, theme)
      .then((r) => live && setTokens(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [source, lang, theme]);
  return tokens;
}
