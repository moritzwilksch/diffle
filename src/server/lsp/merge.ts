import type { LspHoverResponse, LspLocationsResponse } from '@/shared/protocol.js';

/** An answer whose emptiness may have a reason. */
export interface Answer {
  inconclusive?: string;
}

/**
 * The union of what several servers answered. A server that fails drops its share;
 * every one failing is the first failure. When the union is `empty`, the first reason it
 * may be incomplete stands: a server's own, else a failed server's message, so an
 * owner still starting reads as such rather than as silence.
 */
export async function union<T extends Answer>(
  asked: Promise<T>[],
  merge: (answers: T[]) => T,
  empty: (merged: T) => boolean,
): Promise<T> {
  const results = await Promise.allSettled(asked);
  const answers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = results.find((r) => r.status === 'rejected');
  if (!answers.length && failed) throw failed.reason;
  const merged = merge(answers);
  if (empty(merged)) {
    const reason = answers.find((a) => a.inconclusive)?.inconclusive ?? (failed ? messageOf(failed.reason) : undefined);
    if (reason) merged.inconclusive = reason;
  }
  return merged;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Every server's hover, owner first, as one tooltip; the span is the first one offered. */
export function mergeHovers(answers: LspHoverResponse[]): LspHoverResponse {
  const said = answers.filter((a) => a.contents != null);
  if (!said.length) return { contents: null };
  const range = said.find((a) => a.range)?.range;
  return { contents: said.map((a) => a.contents).join('\n\n---\n\n'), ...(range ? { range } : {}) };
}

/** The union of every server's locations, owner first, each place once. */
export function mergeLocations(answers: LspLocationsResponse[]): LspLocationsResponse {
  const seen = new Set<string>();
  const locations = answers.flatMap((a) =>
    a.locations.filter((l) => {
      const key = `${l.path}\0${l.line}\0${l.col}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
  return { locations };
}
