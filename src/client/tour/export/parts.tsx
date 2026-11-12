import { Circle, CircleCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { nodeKey, nodePath, placeOf } from '@/client/tour/anchor.js';
import { primitive } from '@/client/tour/document.js';
import type { CheckProps, SymbolProps } from '@/client/tour/host/host.js';
import type { TourCheckItem } from '@/shared/tour.js';
import type { BakedTour } from './data.js';

/**
 * A symbol chip as it was exported: coloured as in the diff, with its hover from the language
 * server under it while the pointer or the focus is on it. Without a hover it is coloured code.
 */
export function BakedSymbol({ name, baked }: SymbolProps & { baked?: BakedTour['symbols'][string] }) {
  const style = baked?.color ? { color: baked.color } : undefined;
  if (!baked?.hover) return <code style={style}>{name}</code>;
  return (
    <span className="tour-chip" tabIndex={0}>
      <code style={style}>{name}</code>
      <span role="tooltip" className="tour-chip-tip">
        {hoverBlocks(baked.hover)}
      </span>
    </span>
  );
}

/** A hover's Markdown as plain blocks: its fenced code as code, its prose as paragraphs. */
function hoverBlocks(markdown: string): ReactNode[] {
  // Split around fences, the odd parts are their code.
  return markdown.split(/```[^\n]*\n([\s\S]*?)```/).flatMap((part, i) => {
    if (i % 2) return [<pre key={i}>{part.replace(/\n$/, '')}</pre>];
    const paragraphs = part.split(/\n\s*\n|^-{3,}$/m).map((p) => p.trim());
    return paragraphs.filter(Boolean).map((p, j) => <p key={`${i}.${j}`}>{inlineCode(p)}</p>);
  });
}

/** `text` with its backticked spans as code. */
function inlineCode(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

/** A checklist as it stood when the tour was exported: each item marked decided or open. */
export function BakedCheck({ source, renderItem, checks }: CheckProps & { checks: readonly TourCheckItem[] }) {
  const items = [...source.children].flatMap((el) => {
    const item = primitive(el);
    if (item?.tag !== 'diffle-item') return [];
    const key = nodeKey(nodePath(el));
    return [{ el, context: item.context, decided: checks.find((c) => nodeKey(c.node) === key)?.ticked ?? false }];
  });
  return (
    <section {...placeOf(source)} aria-label="Checklist" className="tour-check tour-block">
      <div className="tour-check-head">
        {items.filter((i) => i.decided).length} of {items.length} decided
      </div>
      <ul className="tour-check-items">
        {items.map(({ el, context, decided }, i) => (
          <li key={i} {...placeOf(el)} data-ticked={decided || undefined} className="tour-check-item">
            <span className="tour-check-mark" role="img" aria-label={decided ? 'Decided' : 'Open'}>
              {decided ? <CircleCheck size="1rem" /> : <Circle size="1rem" />}
            </span>
            <div className="min-w-0">
              <div className="tour-check-question">{renderItem(el)}</div>
              {context && <div className="tour-check-context">{context}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
