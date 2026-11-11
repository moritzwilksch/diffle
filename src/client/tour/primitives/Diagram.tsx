import { createElement, type ReactNode, useId } from 'react';
import { type TourSvgClass, TourSvgClassSchema, TourSvgElementSchema } from '@/shared/protocol.js';

type Tone = 'accent' | 'success' | 'warning' | 'error';
const TONES: ReadonlySet<TourSvgClass> = new Set<Tone>(['accent', 'success', 'warning', 'error']);
/** An arrowhead's colour: a marker paints apart from the line it ends, so it cannot inherit the tone. */
const HEAD: Record<Tone | 'ink', string> = {
  ink: 'var(--fg-2)',
  accent: 'var(--accent)',
  success: 'var(--add)',
  warning: 'var(--warn)',
  error: 'var(--danger)',
};
const LINES = new Set(['path', 'line', 'polyline']);

/**
 * A card's diagram, drawn again from what `TourSvgElement` and `TourSvgClass` allow, so styles,
 * scripts and links the agent wrote never reach the page. diffle's stylesheet styles it from the
 * theme, and each arrow gets a head in its line's tone.
 */
export function TourDiagram({ of }: { of: Element }) {
  const id = useId();
  const svg = [...of.children].find((c) => c.localName === 'svg');
  const root = svg ? read(svg) : null;
  if (!svg || root?.tag !== 'svg') return null;
  const width = Number(root.viewBox.split(' ')[2]);
  const head = (tone: Tone | 'ink') => `url(#${CSS.escape(`${id}-${tone}`)})`;
  return (
    <svg viewBox={root.viewBox} width={width} className="tour-diagram">
      <defs>
        {Object.entries(HEAD).map(([tone, fill]) => (
          <marker
            key={tone}
            id={`${id}-${tone}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={10}
            markerHeight={10}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" style={{ fill, stroke: 'none' }} />
          </marker>
        ))}
      </defs>
      {[...svg.childNodes].map((node, i) => draw(node, i, null, head))}
    </svg>
  );
}

function draw(node: ChildNode, key: number, tone: Tone | null, head: (tone: Tone | 'ink') => string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    const inText = node.parentElement?.localName === 'text' || node.parentElement?.localName === 'tspan';
    return inText ? node.textContent : null;
  }
  if (!(node instanceof Element)) return null;
  const element = read(node);
  if (!element || element.tag === 'svg') return null;
  const { tag, class: words = '', ...geometry } = element;
  const classes = words.split(/\s+/).filter((w) => TourSvgClassSchema.safeParse(w).success) as TourSvgClass[];
  const own = (classes.find((c) => TONES.has(c)) as Tone | undefined) ?? tone;
  const arrow = LINES.has(tag) && (classes.includes('arrow') || classes.includes('arrows'));
  const props = {
    key,
    ...geometry,
    className: classes.join(' ') || undefined,
    markerEnd: arrow ? head(own ?? 'ink') : undefined,
    markerStart: arrow && classes.includes('arrows') ? head(own ?? 'ink') : undefined,
  };
  return createElement(tag, props, ...[...node.childNodes].map((child, i) => draw(child, i, own, head)));
}

/** `el` as an element of the diagram catalog, or null when it is none or its attributes do not fit. */
function read(el: Element) {
  const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  const parsed = TourSvgElementSchema.safeParse({ ...attrs, tag: el.localName });
  return parsed.success ? parsed.data : null;
}
