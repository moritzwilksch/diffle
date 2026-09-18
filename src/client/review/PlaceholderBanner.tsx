import { FileWarning, Image, Loader2, TriangleAlert } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { hostOf } from './host.js';

/** Why a file's body has no code lines to show. */
export type PlaceholderKind = 'binary' | 'empty' | 'oversized' | 'error' | 'loading';

const ICON: Record<PlaceholderKind, typeof Image> = {
  binary: Image,
  empty: FileWarning,
  oversized: FileWarning,
  loading: Loader2,
  error: TriangleAlert,
};

/** A file body's stand-in: one muted, icon-led strip that is the whole body under the header. Rendered
 * as a file-level annotation (line 0); `ReviewPane` hides the gutter and rows around it, so it reads as
 * a notice about the file, never as its content. */
export function PlaceholderBanner({ kind, message }: { kind: PlaceholderKind; message: string }) {
  const Icon = ICON[kind];
  const ref = useRef<HTMLDivElement>(null);
  // The viewer's shadow CSS hides the gutter and rows of a host carrying this mark (see ReviewPane).
  useLayoutEffect(() => {
    const host = ref.current && hostOf(ref.current);
    if (!host) return;
    host.setAttribute('data-placeholder', kind);
    return () => host.removeAttribute('data-placeholder');
  }, [kind]);
  return (
    <div
      ref={ref}
      className={`flex items-center gap-2 bg-hover px-4 py-2 text-[0.8125rem] ${
        kind === 'error' ? 'text-danger' : 'text-muted'
      }`}
      data-placeholder={kind}
    >
      <Icon size="0.875rem" className={kind === 'loading' ? 'animate-spin' : undefined} />
      <span>{message}</span>
    </div>
  );
}
