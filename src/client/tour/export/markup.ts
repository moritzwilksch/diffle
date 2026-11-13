import { preloadDiffHTML } from '@pierre/diffs/ssr';
import { ROWS_OPTIONS, rowsDiff } from '@/client/tour/host/live.js';
import { rowsKey } from '@/client/tour/host/host.js';

/** A patch whose rows an export keeps: in `lang` when it is code the agent wrote, unnumbered when it cites a file. */
export interface RowsWanted {
  patch: string;
  lang?: string;
  numbered?: boolean;
}

/**
 * Each patch's rows as the diff renders them, highlighted in both themes, by `rowsKey`, and the
 * one stylesheet they share. Each token's colours become a class, so a token costs a few bytes.
 */
export async function bakeRows(wanted: readonly RowsWanted[]): Promise<{ rows: Record<string, string>; css: string }> {
  const sheets = new Set<string>();
  const classes = new Map<string, string>();
  const rows: Record<string, string> = {};
  for (const { patch, lang, numbered = true } of wanted) {
    const key = rowsKey(patch, lang, numbered);
    const fileDiff = rowsDiff(patch, lang);
    if (key in rows || !fileDiff) continue;
    const html = await preloadDiffHTML({
      fileDiff,
      options: { ...ROWS_OPTIONS, themeType: 'system', disableLineNumbers: !numbered },
    });
    rows[key] = html
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_, css: string) => (sheets.add(css), ''))
      // The sprite draws a file header's and a separator's icons; the tour shows neither.
      .replace(/^<svg[\s\S]*?<\/svg>/, '')
      // Hydrating drops it, and with it a grid column the live rows do not have.
      .replace(' data-dehydrated=""', '')
      .replace(/<span style="([^"]*)">/g, (_, style: string) => {
        let name = classes.get(style);
        if (!name) classes.set(style, (name = `t${classes.size.toString(36)}`));
        return `<span class="${name}">`;
      });
  }
  const tokens = [...classes].map(([style, name]) => `.${name}{${style}}`);
  return { rows, css: [...sheets, ...tokens].join('\n') };
}
