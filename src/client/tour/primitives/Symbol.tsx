import type { Side } from '@/shared/protocol.js';

/** A symbol on a line of the review, as code. */
export function TourSymbol({ name }: { path: string; line: number; name: string; side: Side }) {
  return <code>{name}</code>;
}
