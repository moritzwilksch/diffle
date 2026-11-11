import { Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

/** A highlighted aside behind a straight left rule: `note` in the accent, `warning` in the warning colour. */
export function Callout({ kind, children }: { kind: 'note' | 'warning'; children: ReactNode }) {
  const color = kind === 'warning' ? 'var(--warn)' : 'var(--accent)';
  const Icon = kind === 'warning' ? TriangleAlert : Info;
  return (
    <aside
      className="tour-block flex gap-2 rounded-r-md border-l-3 px-3 py-2"
      style={{ borderColor: color, background: `color-mix(in srgb, ${color} 8%, var(--bg))` }}
      aria-label={kind}
    >
      <Icon size="0.875rem" color={color} className="mt-0.5 shrink-0" />
      <div className="markdown min-w-0">{children}</div>
    </aside>
  );
}
