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
