import { type MouseEvent, useEffect, useState } from 'react';
import { highlightLines } from '@/client/lsp/highlight.js';
import { hoverControl } from '@/client/lsp/HoverTooltip.js';
import type { TokenTarget } from '@/client/lsp/target.js';
import { useStore } from '@/client/store.js';
import { lspBlocker } from '@/shared/lsp.js';
import type { Side } from '@/shared/side.js';
import type { SymbolProps } from './host.js';

/**
 * A chip for the symbol `name` on `line` of `path`, coloured as the highlighter colours it on that
 * line. Hovering shows the diff's hover card, and a click opens the diff's symbol menu (⌘/Ctrl+click
 * goes to the definition). While the language servers cannot answer, it is coloured code naming why.
 */
export function LiveSymbol({ path, line, name, side }: SymbolProps) {
  const blocker = useStore((s) =>
    side === 'old' ? 'Symbol navigation works on the new side only' : lspBlocker(s.lsp, s.snapshot, { path }),
  );
  const { col, color } = useToken(path, side, line, name);
  const style = color ? { color } : undefined;
  if (blocker)
    return (
      <code title={blocker} style={style}>
        {name}
      </code>
    );
  const target = col == null ? null : { path, side, line, col, text: name };
  return (
    <button
      type="button"
      className="cursor-pointer rounded-sm border-0 bg-transparent p-0 align-baseline hover:underline"
      onPointerEnter={(e) => target && hoverControl.enter(target, e.currentTarget)}
      onPointerLeave={() => hoverControl.leave()}
      onClick={(e) => openMenu(target, e, `${name} is no longer on line ${line} of ${path}`)}
      aria-haspopup="menu"
    >
      <code style={style}>{name}</code>
    </button>
  );
}

/** What a click on a symbol in the diff does: the menu, or straight to the definition with ⌘/Ctrl. */
function openMenu(target: TokenTarget | null, e: MouseEvent, moved: string): void {
  const store = useStore.getState();
  hoverControl.cancel();
  if (!target) return store.flash(moved);
  if (e.ctrlKey || e.metaKey) return void store.goToDefinition(target);
  void store.openSymbolMenu(target, e.clientX, e.clientY);
}

/** Where `name` sits on its line, and the colour the highlighter gives it there. */
function useToken(path: string, side: Side, line: number, name: string): { col: number | null; color?: string } {
  const theme = useStore((s) => s.theme);
  const version = useStore((s) => s.snapshot?.version);
  const [token, setToken] = useState<{ col: number | null; color?: string }>({ col: null });
  useEffect(() => {
    let live = true;
    void (async () => {
      const text = await useStore.getState().readSide(path, side);
      const lineText = text?.split('\n')[line - 1] ?? '';
      const col = wordColumn(lineText, name);
      if (!live) return;
      setToken({ col });
      if (col == null) return;
      const [tokens = []] = await highlightLines([lineText], path, theme);
      let at = 0;
      const hit = tokens.find((t) => (at += t.text.length) > col);
      if (live) setToken({ col, color: hit?.color });
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [path, side, line, name, theme, version]);
  return token;
}

/** Where `name` first occurs in `line` as a whole word, as the server checked it when the tour was pushed. */
export function wordColumn(line: string, name: string): number | null {
  const word = /[\p{L}\p{N}_]/u;
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const [before, after] = [line[at - 1], line[at + name.length]];
    if (!(before && word.test(before)) && !(after && word.test(after))) return at;
  }
  return null;
}
