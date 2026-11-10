import { api } from '@/client/api.js';
import { useStore } from '@/client/store.js';
import { source } from '@/client/tour/state.js';
import { lspBlocker } from '@/shared/lsp.js';
import type { Side } from '@/shared/protocol.js';

/**
 * A chip for the symbol `name` on `line` of `path`: a click lists its references, as `gA` does in
 * the diff. While the language servers cannot answer, it is plain code naming why.
 */
export function TourSymbol({ path, line, name, side }: { path: string; line: number; name: string; side: Side }) {
  const blocker = useStore((s) =>
    side === 'old'
      ? 'References are asked of the new side; this symbol is on the old one'
      : lspBlocker(s.lsp, s.snapshot, { path, feature: 'references' }),
  );
  if (blocker) return <code title={blocker}>{name}</code>;
  return (
    <button
      type="button"
      className="cursor-pointer rounded-sm border-0 bg-transparent p-0 align-baseline hover:underline"
      // The canvas pans on a press; a press on the chip is the chip's.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => void references(path, line, name)}
      title={`References to ${name}`}
    >
      <code className="text-accent">{name}</code>
    </button>
  );
}

async function references(path: string, line: number, name: string): Promise<void> {
  const store = useStore.getState();
  try {
    const { text } = await source(path, 'new');
    const col = text == null ? null : wordColumn(text.split('\n')[line - 1] ?? '', name);
    if (col == null) return store.flash(`${name} is no longer on line ${line} of ${path}`);
    const { locations, inconclusive } = await api.lspReferences({ path, line, col });
    if (!locations.length) return store.flash(inconclusive ?? `No references to ${name}`);
    store.showReferences({ kind: 'references', symbol: name, items: locations });
  } catch (e) {
    store.flash(`Finding references to ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Where `name` first occurs in `line` as a whole word, as the server checked it when the tour was pushed. */
function wordColumn(line: string, name: string): number | null {
  const word = /[\p{L}\p{N}_]/u;
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const [before, after] = [line[at - 1], line[at + name.length]];
    if (!(before && word.test(before)) && !(after && word.test(after))) return at;
  }
  return null;
}
