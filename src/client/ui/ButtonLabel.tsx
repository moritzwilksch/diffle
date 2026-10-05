import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Button text whose width eases between values, so arming, confirming, or acknowledging a
 * button does not jolt its neighbors. Falsy `text` collapses the label; the last text stays
 * inside, hidden, while it shrinks.
 */
export function ButtonLabel({ text }: { text?: string | false | null }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const settled = useRef<number | null>(null);
  const [last, setLast] = useState(text || '');
  if (text && text !== last) setLast(text);

  useLayoutEffect(() => {
    const o = outer.current!;
    const to = text ? inner.current!.getBoundingClientRect().width : 0;
    const from = o.style.width ? o.getBoundingClientRect().width : settled.current;
    settled.current = to;
    if (from === null || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      o.style.width = text ? '' : '0px';
      return;
    }
    o.style.width = `${from}px`;
    void o.offsetWidth; // commit the start width so the change below transitions
    o.style.width = `${to}px`;
  }, [text, last]);

  return (
    <span
      ref={outer}
      aria-hidden={!text || undefined}
      // The negative margin cancels the button's gap while collapsed; the inner padding restores it.
      className="-ml-1.25 inline-block overflow-hidden [transition:width_180ms_cubic-bezier(0.2,0.8,0.2,1)]"
      onTransitionEnd={(e) => {
        // Settle on auto width so a late font swap cannot clip the text.
        if (e.propertyName === 'width' && text) outer.current!.style.width = '';
      }}
    >
      <span ref={inner} className="inline-block pl-1.25 whitespace-nowrap">
        {text || last}
      </span>
    </span>
  );
}
