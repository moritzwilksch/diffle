import { createElement, Fragment, type ReactNode, useId } from 'react';
import {
  type TourSvgClass,
  TourSvgClassSchema,
  TourSvgElementSchema,
  TourSvgIconSchema,
} from '@/shared/tour-catalog.js';
import { DiagramCode } from './DiagramCode.js';
import { LucideIcon } from './Icon.js';
import { type Place, placeOf } from '@/client/tour/anchor.js';

type Tone = 'accent' | 'success' | 'warning' | 'error' | 'contrast-a' | 'contrast-b';
const TONES: ReadonlySet<TourSvgClass> = new Set<Tone>([
  'accent',
  'success',
  'warning',
  'error',
  'contrast-a',
  'contrast-b',
]);
/** An arrowhead's colour: a marker paints apart from the line it ends, so it cannot inherit the tone. */
const HEAD: Record<Tone | 'ink', string> = {
  ink: 'var(--fg-2)',
  accent: 'var(--accent)',
  success: 'var(--add)',
  warning: 'var(--warn)',
  error: 'var(--danger)',
  'contrast-a': 'var(--contrast-a)',
  'contrast-b': 'var(--contrast-b)',
};

/** Which state a morph's drawing shows: one of its two, or both with the change coloured. */
export type MorphState = 'before' | 'after' | 'diff';

/** The tone a morph's Diff gives a group that is in one state alone, or moves. */
const CHANGE = { before: 'error', after: 'success', move: 'accent' } as const;
const LINES = new Set(['path', 'line', 'polyline']);
/** An icon's width and height without `size`. */
const ICON_SIZE = '14';

/**
 * A diagram, drawn again from what `TourSvgElement` and `TourSvgClass` allow, so styles, scripts
 * and links the agent wrote never reach the page. diffle's stylesheet styles it from the theme,
 * and each arrow gets a head in its line's tone. In a stepped diagram, `active` names the step
 * whose groups are lit; the other steps' groups dim. In a morph, `morph` names the state shown: a
 * group in the other state fades, a moved group slides, and the Diff colours the change and outlines
 * where a moved group was. `place` names the diagram where the drawing stands for it; a stepped
 * diagram's or a morph's frame carries it instead.
 */
export function TourDrawing({
  of,
  place,
  active = null,
  morph,
}: {
  of: Element;
  place?: Place;
  active?: number | null;
  morph?: MorphState;
}) {
  const id = useId();
  const svg = [...of.children].find((c) => c.localName === 'svg');
  const root = svg ? read(svg) : null;
  if (!svg || root?.tag !== 'svg') return null;
  const width = Number(root.viewBox.split(' ')[2]);
  const head = (tone: Tone | 'ink') => `url(#${CSS.escape(`${id}-${tone}`)})`;
  return (
    <svg
      {...place}
      data-opaque=""
      data-stepping={active != null || undefined}
      data-morph={morph}
      viewBox={root.viewBox}
      className="tour-diagram"
      style={{ width: `calc(${width}px * var(--diffle-text-scale, 1))` }}
    >
      <defs>
        {Object.entries(HEAD).map(([tone, fill]) => (
          <marker
            key={tone}
            id={`${id}-${tone}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" style={{ fill, stroke: 'none' }} />
          </marker>
        ))}
      </defs>
      {[...svg.childNodes].map((node, i) => draw(node, i, null, { head, active, morph, ghost: false }))}
    </svg>
  );
}

/** What every element of a drawing is drawn with: its arrowheads, the step lit, the morph's state, and whether it is a moved group's outline. */
interface Drawn {
  head: (tone: Tone | 'ink') => string;
  active: number | null;
  morph: MorphState | undefined;
  /** The outline of where a moved group was, which names no element of the source. */
  ghost: boolean;
}

function draw(node: ChildNode, key: number, tone: Tone | null, drawn: Drawn): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    const inText = node.parentElement?.localName === 'text' || node.parentElement?.localName === 'tspan';
    return inText ? node.textContent : null;
  }
  if (!(node instanceof Element)) return null;
  if (node.localName === 'svg') return icon(node, key);
  const element = read(node);
  if (!element || element.tag === 'svg') return null;
  const { tag, class: words = '', ...rest } = element;
  const {
    lang,
    step,
    in: state,
    move,
    ...geometry
  } = { lang: undefined, step: undefined, in: undefined, move: undefined, ...rest };
  const lit = step != null && Number(step) === drawn.active;
  const classes = words.split(/\s+/).filter((w) => TourSvgClassSchema.safeParse(w).success) as TourSvgClass[];
  const changed = state ?? (move == null ? null : 'move');
  const change = drawn.morph === 'diff' && !drawn.ghost && changed ? CHANGE[changed] : undefined;
  // A lit step's arrows take the accent with its lines, and a morph's changed ones its change colour.
  const own = (classes.find((c) => TONES.has(c)) as Tone | undefined) ?? change ?? (lit ? 'accent' : tone);
  const arrow = LINES.has(tag) && (classes.includes('arrow') || classes.includes('arrows'));
  const [dx, dy] = move?.split(' ') ?? [];
  const props = {
    key,
    ...(drawn.ghost ? {} : placeOf(node)),
    ...geometry,
    className: classes.join(' ') || undefined,
    'data-step': step,
    'data-lit': lit || undefined,
    'data-in': state,
    'data-move': move == null ? undefined : '',
    style: move == null ? undefined : { '--dx': `${dx}px`, '--dy': `${dy}px` },
    markerEnd: arrow ? drawn.head(own ?? 'ink') : undefined,
    markerStart: arrow && classes.includes('arrows') ? drawn.head(own ?? 'ink') : undefined,
  };
  if (tag === 'text' && classes.includes('code')) {
    const lines = [...node.children].flatMap((child) => {
      const line = read(child);
      if (line?.tag !== 'tspan') return [];
      const { tag: _, class: __, ...at } = line;
      return [{ at, text: child.textContent ?? '' }];
    });
    return <DiagramCode key={key} props={props} lines={lines} lang={lang ?? 'text'} />;
  }
  const drawing = createElement(tag, props, ...[...node.childNodes].map((child, i) => draw(child, i, own, drawn)));
  if (move == null || drawn.ghost) return drawing;
  // Where the group was: its shapes again, outlined, under the group that moves away.
  const ghost = { ...drawn, ghost: true };
  return (
    <Fragment key={key}>
      <g data-ghost="" aria-hidden>
        {[...node.childNodes].map((child, i) => draw(child, i, null, ghost))}
      </g>
      {drawing}
    </Fragment>
  );
}

/** An `<svg data-lucide>` in the drawing: the icon, in its text's colour or its tone. */
function icon(node: Element, key: number): ReactNode {
  const attrs = Object.fromEntries([...node.attributes].map((a) => [a.name, a.value]));
  const parsed = TourSvgIconSchema.safeParse({ ...attrs, tag: 'svg' });
  if (!parsed.success) return null;
  const { 'data-lucide': name, x, y, size = ICON_SIZE, class: words = '' } = parsed.data;
  const tones = words.split(/\s+/).filter((w) => TONES.has(w as TourSvgClass));
  return (
    <LucideIcon key={key} name={name} x={x} y={y} size={size} className={['tour-diagram-icon', ...tones].join(' ')} />
  );
}

/** `el` as an element of the diagram catalog, or null when it is none or its attributes do not fit. */
function read(el: Element) {
  const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  const parsed = TourSvgElementSchema.safeParse({ ...attrs, tag: el.localName });
  return parsed.success ? parsed.data : null;
}
