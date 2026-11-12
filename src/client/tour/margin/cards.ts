/** A card in the margin: where its anchor is and how tall it is, in the margin's pixels. */
export interface MarginItem {
  id: string;
  want: number;
  height: number;
}

/** Room between two cards. */
export const CARD_GAP = 8;

/**
 * Each card's top, in the order given (document order): at its anchor, or below the card above it.
 * The active card sits exactly at its anchor and pushes the cards above it up, never past the top.
 */
export function placeCards(items: readonly MarginItem[], active: string | null): Map<string, number> {
  const tops: number[] = [];
  const pinned = items.findIndex((item) => item.id === active);
  const from = Math.max(0, pinned);
  for (let i = from; i < items.length; i++) {
    const item = items[i]!;
    const below = i > from ? tops[i - 1]! + items[i - 1]!.height + CARD_GAP : -Infinity;
    tops[i] = i === pinned ? item.want : Math.max(item.want, below);
  }
  for (let i = from - 1; i >= 0; i--) {
    const item = items[i]!;
    tops[i] = Math.max(0, Math.min(item.want, tops[i + 1]! - CARD_GAP - item.height));
  }
  return new Map(items.map((item, i) => [item.id, tops[i]!]));
}

/** Room a card takes in the margin, from its top. */
export interface Taken {
  top: number;
  height: number;
}

/**
 * The top nearest `want` where something `height` tall covers none of the cards: `want` itself, or
 * just below or just above a card. The cards stay where they are.
 */
export function freeSpot(want: number, height: number, cards: readonly Taken[]): number {
  const clear = (top: number) =>
    top >= 0 && cards.every((c) => top + height + CARD_GAP <= c.top || top >= c.top + c.height + CARD_GAP);
  const candidates = [want, ...cards.flatMap((c) => [c.top + c.height + CARD_GAP, c.top - CARD_GAP - height])].filter(
    clear,
  );
  return candidates.reduce((best, top) => (Math.abs(top - want) < Math.abs(best - want) ? top : best), Infinity);
}
