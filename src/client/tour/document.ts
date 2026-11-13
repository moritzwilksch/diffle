import { type Side } from '@/shared/side.js';
import { type TourElement, TourElementSchema } from '@/shared/tour-catalog.js';

/** Lines of one side of a file, as a `diffle-diff` names them. */
export interface LineRange {
  path: string;
  side: Side;
  start: number;
  end: number;
}

/** A heading of the table of contents. */
export interface TourHeading {
  title: string;
  /** Its place among the article's headings of its level, which finds it on the page. */
  index: number;
}

/** An `h2` section: a step of the walk, with its `h3` subsections. */
export interface TourSection extends TourHeading {
  subsections: TourHeading[];
  /** The lines its `diffle-diff`s, `diffle-walk`s and `diffle-stop`s show, which decide whether it holds a stale one. */
  ranges: LineRange[];
}

export interface TourDocument {
  /** The `h1`, when the tour has one. */
  title: string | null;
  /** The article's body, which the page renders. */
  body: HTMLElement;
  /** In document order: the walk's steps. */
  sections: TourSection[];
}

/**
 * The tour in `html`, read as the server checked it: an article whose `h2`s are the walk's steps.
 * What the catalog in `tour-catalog.ts` does not allow is left out when it renders.
 */
export function readTour(html: string): TourDocument {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  let title: string | null = null;
  const sections: TourSection[] = [];
  let subsections = 0;
  for (const el of body.children) {
    const text = el.textContent?.trim() ?? '';
    const section = sections[sections.length - 1];
    if (el.localName === 'h1') title ??= text;
    else if (el.localName === 'h2') sections.push({ title: text, index: sections.length, subsections: [], ranges: [] });
    else if (el.localName === 'h3') {
      section?.subsections.push({ title: text, index: subsections });
      subsections++;
    } else section?.ranges.push(...rangesIn(el));
  }
  return { title, body, sections };
}

/** `el` as a `diffle-*` element of the catalog, or null when it is none or its attributes do not fit. */
export function primitive(el: Element): TourElement | null {
  const tag = el.localName;
  if (!tag.startsWith('diffle-')) return null;
  const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  const parsed = TourElementSchema.safeParse({ ...attrs, tag });
  return parsed.success ? parsed.data : null;
}

/** The start and end of a `lines` attribute: `40-58`, or `40` alone. */
export function lineSpan(lines: string): [number, number] {
  const [start = 0, end = start] = lines.split('-').map(Number);
  return [start, end];
}

/** An element that shows lines of the review. */
type Ranged = Extract<TourElement, { tag: 'diffle-diff' | 'diffle-walk' | 'diffle-stop' }>;

/** The review's lines `element` shows: a diff's or a walk's `lines`, a stop's `line`; null for any other element. */
export function rangeOf(element: Ranged): LineRange;
export function rangeOf(element: TourElement): LineRange | null;
export function rangeOf(element: TourElement): LineRange | null {
  switch (element.tag) {
    case 'diffle-diff':
    case 'diffle-walk': {
      const [start, end] = lineSpan(element.lines);
      return { path: element.path, side: element.side ?? 'new', start, end };
    }
    case 'diffle-stop': {
      const line = Number(element.line);
      return { path: element.path, side: element.side ?? 'new', start: line, end: line };
    }
    default:
      return null;
  }
}

/** The lines of the `diffle-diff`s, `diffle-walk`s and `diffle-stop`s at or inside `el`. */
function rangesIn(el: Element): LineRange[] {
  return [el, ...el.querySelectorAll('diffle-diff, diffle-walk, diffle-stop')].flatMap((found) => {
    const element = primitive(found);
    const range = element && rangeOf(element);
    return range ? [range] : [];
  });
}
