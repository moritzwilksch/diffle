/** Word runs shared by pointer hit-testing and keyboard navigation; offsets are UTF-16 columns. */
export function wordsIn(text: string): { start: number; text: string }[] {
  return [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({ start: match.index, text: match[0] }));
}
