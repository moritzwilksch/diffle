import type { SupportedLanguages } from '@pierre/diffs';
import { api } from '@/client/api.js';
import { highlightCode, highlightLines, type HlToken } from '@/client/lsp/highlight.js';
import { useStore } from '@/client/store.js';
import type { SymbolProps, Token } from '@/client/tour/host/host.js';
import { wordColumn } from '@/client/tour/host/LiveSymbol.js';
import { loadIcon } from '@/client/tour/host/live.js';
import { lineSpan, type LineRange, primitive } from '@/client/tour/document.js';
import { codeLang, codePatch } from '@/client/tour/primitives/Code.js';
import { rangePatch, source, type TourLoad } from '@/client/tour/state.js';
import { AROUND } from '@/client/tour/steps/Trace.js';
import { type BakedTour, excerptKey, symbolKey, tokensKey } from './data.js';
import { bakeRows, type RowsWanted } from './markup.js';

type Ready = Extract<TourLoad, { state: 'ready' }>;

/**
 * Everything the tour `load` shows, read from the review as it stands: each excerpt's rows, each
 * symbol's colour and hover, each diagram's code coloured, its icons, its trees' files and the
 * ticks. Comments stay out: they are the reviewer's conversation with their agent. The browser bakes
 * it, not a server command: only the client has the highlighter.
 */
export async function bakeTour({ tour, doc, checks }: Ready): Promise<BakedTour> {
  const excerpts: [LineRange, number][] = [];
  const codes: RowsWanted[] = [];
  const symbols: SymbolProps[] = [];
  const diagrams: { lines: string[]; lang: string }[] = [];
  const icons = new Set<string>();
  const listed = new Set<string>();
  for (const el of doc.body.querySelectorAll('*')) {
    if (el.localName === 'svg' && el.hasAttribute('data-lucide')) icons.add(el.getAttribute('data-lucide')!);
    if (el.localName === 'text' && el.classList.contains('code')) {
      const lines = [...el.children].filter((c) => c.localName === 'tspan').map((c) => c.textContent ?? '');
      diagrams.push({ lines, lang: el.getAttribute('lang') ?? 'text' });
    }
    const element = primitive(el);
    if (element && 'icon' in element && element.icon) icons.add(element.icon);
    switch (element?.tag) {
      case 'diffle-diff':
      case 'diffle-walk': {
        const [start, end] = lineSpan(element.lines);
        excerpts.push([{ path: element.path, side: element.side ?? 'new', start, end }, 0]);
        break;
      }
      case 'diffle-stop': {
        const line = Number(element.line);
        excerpts.push([{ path: element.path, side: element.side ?? 'new', start: line, end: line }, AROUND]);
        break;
      }
      case 'diffle-code': {
        codes.push({ patch: codePatch(el.textContent ?? ''), lang: codeLang(element.lang, element.path) });
        break;
      }
      case 'diffle-symbol':
        symbols.push({
          path: element.path,
          line: Number(element.line),
          name: element.name,
          side: element.side ?? 'new',
        });
        break;
      case 'diffle-icon':
        icons.add(element.name);
        break;
      case 'diffle-tree':
        for (const path of element.paths.split('\n')) listed.add(path.trim());
        break;
    }
  }

  const patches = await Promise.all(excerpts.map(([range, context]) => rangePatch(range, context)));
  const { rows, css } = await bakeRows([...patches.flatMap((patch) => (patch == null ? [] : [{ patch }])), ...codes]);
  const baked: BakedTour = {
    html: tour.html,
    excerpts: Object.fromEntries(excerpts.map(([range, context], i) => [excerptKey(range, context), patches[i]!])),
    rows,
    rowsCss: css,
    symbols: {},
    tokens: {},
    icons: {},
    changed: (useStore.getState().snapshot?.changed ?? []).filter((f) => listed.has(f.path)),
    checks,
  };
  for (const symbol of symbols) baked.symbols[symbolKey(symbol)] = await bakeSymbol(symbol);
  for (const { lines, lang } of diagrams) {
    const [light, dark] = await Promise.all(
      (['light', 'dark'] as const).map((theme) => highlightCode(lines, lang as SupportedLanguages, theme)),
    );
    baked.tokens[tokensKey(lines, lang)] = bothThemes(light!, dark!);
  }
  for (const name of icons) {
    const node = await loadIcon(name);
    if (node) baked.icons[name] = node;
  }
  return baked;
}

/** A symbol chip's colour in both themes, and its hover when its language server has one. */
async function bakeSymbol({ path, line, name, side }: SymbolProps): Promise<BakedTour['symbols'][string]> {
  const { text } = await source(path, side);
  const lineText = text?.split('\n')[line - 1] ?? '';
  const col = wordColumn(lineText, name);
  if (col == null) return {};
  const [light, dark] = await Promise.all(
    (['light', 'dark'] as const).map((theme) => highlightLines([lineText], path, theme)),
  );
  let at = 0;
  const hit = bothThemes(light!, dark!)[0]?.find((t) => (at += t.text.length) > col);
  if (side === 'old') return { color: hit?.color };
  const hover = await api.lspHover({ path, line, col }).then(
    (h) => h.contents ?? undefined,
    () => undefined,
  );
  return { color: hit?.color, hover };
}

/** Lines coloured in the light theme and in the dark one, as runs whose colour names both. */
export function bothThemes(light: readonly HlToken[][], dark: readonly HlToken[][]): Token[][] {
  return light.map((row, i) => {
    const darkColors = (dark[i] ?? []).flatMap((t) => [...t.text].map(() => t.color));
    const runs: Token[] = [];
    let at = 0;
    for (const token of row) {
      for (const char of token.text) {
        const other = darkColors[at++];
        const color = token.color && other ? `light-dark(${token.color}, ${other})` : (token.color ?? other);
        const last = runs[runs.length - 1];
        if (last && last.color === color) last.text += char;
        else runs.push({ text: char, color });
      }
    }
    return runs;
  });
}
