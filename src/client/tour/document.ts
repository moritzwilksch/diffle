import { type Side, type TourElement, TourElementSchema } from '@/shared/protocol.js';

/** Lines of one side of a file, as a `diffle-diff` names them. */
export interface LineRange {
  path: string;
  side: Side;
  start: number;
  end: number;
}

/** A card of the page, a step of the walk when it has a number. */
export interface TourCard {
  id: string;
  title: string;
  step: number | null;
  /** The `diffle-group` holding it, by its position among the document's groups. */
  group: number | null;
  /** The element whose children the card shows. */
  body: Element;
  /** The lines its `diffle-diff`s show, which decide whether it went stale. */
  ranges: LineRange[];
}

export interface TourDocument {
  /** In document order. */
  cards: TourCard[];
  /** Each group's title, by position. */
  groups: string[];
  /** The cards with a step, in walk order. */
  steps: TourCard[];
}

/** A run of the page: one card alone, or a `diffle-group`'s cards under its title. */
export interface TourSection {
  title: string | null;
  cards: TourCard[];
}

/**
 * The page in reading order: the walk's steps in order, then the cards without one in document
 * order. A group stays one section, placed at its first step, its stepped cards before the rest.
 */
export function pageOrder(doc: TourDocument): TourSection[] {
  const rank = (c: TourCard) => c.step ?? Infinity;
  const sections: (TourSection & { at: number })[] = [];
  for (const card of doc.cards) {
    const open = card.group == null ? undefined : sections.find((s) => s.cards[0]!.group === card.group);
    if (open) open.cards.push(card);
    else sections.push({ title: card.group == null ? null : doc.groups[card.group]!, cards: [card], at: 0 });
  }
  for (const s of sections) {
    s.cards.sort((a, b) => rank(a) - rank(b));
    s.at = rank(s.cards[0]!);
  }
  // Stable: sections without a step keep document order.
  return sections.sort((a, b) => a.at - b.at).map(({ title, cards }) => ({ title, cards }));
}

/**
 * The tour in `html`, read as the server checked it. What the catalog in `protocol.ts` does not
 * allow is left out, so a document that slipped past the server still shows only what it may.
 */
export function readTour(html: string): TourDocument {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const cards: TourCard[] = [];
  const groups: string[] = [];
  const addCard = (el: Element, group: number | null) => {
    const card = primitive(el);
    if (card?.tag !== 'diffle-card' || cards.some((c) => c.id === card.id)) return;
    const step = card.step == null ? null : Number(card.step);
    cards.push({ id: card.id, title: card.title, step, group, body: el, ranges: rangesIn(el) });
  };
  for (const el of body.children) {
    const element = primitive(el);
    if (element?.tag === 'diffle-card') addCard(el, null);
    else if (element?.tag === 'diffle-group') {
      groups.push(element.title);
      for (const child of el.children) addCard(child, groups.length - 1);
    }
  }
  const steps = cards.filter((c) => c.step != null).sort((a, b) => a.step! - b.step!);
  return { cards, groups, steps };
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

function rangesIn(card: Element): LineRange[] {
  const ranges: LineRange[] = [];
  for (const el of card.querySelectorAll('diffle-diff')) {
    const diff = primitive(el);
    if (diff?.tag !== 'diffle-diff') continue;
    const [start, end] = lineSpan(diff.lines);
    ranges.push({ path: diff.path, side: diff.side ?? 'new', start, end });
  }
  return ranges;
}
