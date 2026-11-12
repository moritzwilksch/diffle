import type { ReactNode } from 'react';
import { useHost } from '@/client/tour/host/host.js';

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
  const rows = useHost().useTokens(
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
