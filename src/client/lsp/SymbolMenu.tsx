import { Crosshair, Link2, Shapes } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { remPx } from '../scale.js';
import { useStore } from '../store.js';
import { CodeLine, useHighlighted } from './highlight.js';

/** Popover at a clicked symbol: go to definition, list references, or go to its type's definition. Any other click, scroll, or Esc closes it. */
export function SymbolMenu() {
  const menu = useStore((s) => s.symbolMenu);
  const theme = useStore((s) => s.theme);
  const close = useStore((s) => s.closeSymbolMenu);
  const goToDefinition = useStore((s) => s.goToDefinition);
  const goToTypeDefinition = useStore((s) => s.goToTypeDefinition);
  const findReferences = useStore((s) => s.findReferences);
  const items = useMemo(() => (menu ? [{ path: menu.target.path, text: menu.target.text }] : []), [menu]);
  const highlighted = useHighlighted(items, theme);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.composedPath() as HTMLElement[]).some((n) => n instanceof HTMLElement && n.classList?.contains('symbol-menu'))) close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu, close]);

  if (!menu) return null;
  // Keep the popover on screen: flip above the click near the bottom, clamp at the right edge.
  const rem = remPx();
  const width = 28.75 * rem;
  const height = 2.75 * rem;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8));
  const below = menu.y + height < window.innerHeight;
  const style = below ? { left, top: menu.y + 12 } : { left, top: menu.y - height };
  return (
    <div className="symbol-menu" style={style} role="menu">
      <button onClick={() => void goToDefinition(menu.target)} title="Go to definition (gd)">
        <Crosshair size="0.8125rem" /> Definition <kbd>gd</kbd>
      </button>
      <button onClick={() => void findReferences(menu.target)} title="Find references (gA)">
        <Link2 size="0.8125rem" /> References <kbd>gA</kbd>
      </button>
      <button onClick={() => void goToTypeDefinition(menu.target)} title="Go to type definition (gy)">
        <Shapes size="0.8125rem" /> Type <kbd>gy</kbd>
      </button>
      <span className="name" title={menu.target.text}>
        <CodeLine tokens={highlighted.get(`${menu.target.path}\n${menu.target.text}`)} fallback={menu.target.text} />
      </span>
    </div>
  );
}
