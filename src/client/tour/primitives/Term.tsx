import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type TipAnchor, TipSurface } from '@/client/ui/TipSurface.js';

/** Pointer rest before a definition shows, as a control's tip waits. */
const SHOW_MS = 250;

/**
 * A term the tour defines, underlined dotted; resting the pointer on it or focusing it shows its
 * definition in a tip. `defines` marks where the prose defines it, as a `<dfn>`; elsewhere it repeats
 * the definition at a later section's first use.
 */
export function TourTerm({ def, defines, children }: { def: string; defines: boolean; children: ReactNode }) {
  const [anchor, setAnchor] = useState<TipAnchor | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const hide = (e: Event) => (e.type !== 'keydown' || (e as KeyboardEvent).key === 'Escape') && setAnchor(null);
    // A scroll would leave the tip hanging where the term was.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide, true);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide, true);
    };
  }, [anchor]);
  const show = (el: HTMLElement, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setAnchor({ left: r.left, top: r.top, bottom: r.bottom });
    }, delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setAnchor(null);
  };
  const Tag = defines ? 'dfn' : 'span';
  return (
    <>
      <Tag
        className="tour-term"
        tabIndex={0}
        aria-description={def}
        data-shown={anchor ? '' : undefined}
        onPointerEnter={(e) => show(e.currentTarget, SHOW_MS)}
        onPointerLeave={hide}
        onFocus={(e) => e.currentTarget.matches(':focus-visible') && show(e.currentTarget, 0)}
        onBlur={hide}
      >
        {children}
      </Tag>
      {anchor && (
        <TipSurface
          anchor={anchor}
          className="pointer-events-none max-w-[min(22rem,_90vw)] origin-top-left [animation:tip-in_150ms_ease-out] text-[0.8125rem] leading-[1.45] motion-reduce:animate-none"
        >
          {def}
        </TipSurface>
      )}
    </>
  );
}
