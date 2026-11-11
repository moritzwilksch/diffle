import { Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { TourElement } from '@/shared/protocol.js';
import type { ReactNode } from 'react';
import type { Place } from '@/client/tour/anchor.js';

type Kind = Extract<TourElement, { tag: 'diffle-callout' }>['kind'];

const LOOK = {
  info: { color: 'var(--accent)', Icon: Info },
  warning: { color: 'var(--warn)', Icon: TriangleAlert },
  danger: { color: 'var(--danger)', Icon: OctagonAlert },
} satisfies Record<Kind, unknown>;

/** A highlighted aside behind a straight left rule, coloured and marked by its kind. */
export function Callout({ kind, children, place }: { kind: Kind; children: ReactNode; place?: Place }) {
  const { color, Icon } = LOOK[kind];
  return (
    <aside
      {...place}
      className="tour-block flex gap-2 rounded-r-md border-l-3 px-3 py-2"
      style={{ borderColor: color, background: `color-mix(in srgb, ${color} 8%, var(--bg))` }}
      aria-label={kind}
    >
      <Icon size="0.875rem" color={color} className="mt-0.5 shrink-0" />
      <div className="markdown min-w-0">{children}</div>
    </aside>
  );
}
