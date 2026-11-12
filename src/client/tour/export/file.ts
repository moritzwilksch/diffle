import { api } from '@/client/api.js';
import type { ExportNotices } from '@/shared/notices.js';
import type { TourLoad } from '@/client/tour/state.js';
import { bakeTour } from './bake.js';
import { type BakedTour, DATA_ID } from './data.js';

/**
 * Saves the tour `load` as one HTML file named after its title: the tour as the review shows it
 * now, its script and styles inlined, readable offline in either theme. Its policy lets it load
 * nothing but what it holds.
 */
export async function exportTour(load: Extract<TourLoad, { state: 'ready' }>): Promise<void> {
  const [baked, runtime] = await Promise.all([bakeTour(load), api.tourRuntime()]);
  // A client built without the export answers with its page instead.
  if (runtime.js.trimStart().startsWith('<')) throw new Error('this build of diffle cannot export tours');
  const title = load.doc.title ?? 'Tour';
  const notices = JSON.parse(runtime.notices) as ExportNotices;
  const file = new Blob([tourFile(baked, title, { ...runtime, notices })], { type: 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = `${title.replace(/[\\/:*?"<>|]+/g, '-').trim()}.html`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * The exported file: a page holding the tour's data, the script that draws it, and its styles,
 * opened by a list of what they bundle and closed by the full licence texts that list owes.
 */
export function tourFile(
  baked: BakedTour,
  title: string,
  { js, css, notices }: { js: string; css: string; notices: ExportNotices },
): string {
  // Nothing in a script or style element may close it early.
  const inline = (text: string) => text.replace(/<\/(script|style)/gi, '<\\/$1');
  const data = JSON.stringify(baked).replace(/</g, '\\u003c');
  return `<!doctype html>
${comment(['This page was exported from diffle. It bundles these, each under its licence, given in full at the end:', ...notices.bundled])}
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<meta name="generator" content="diffle">
<title>${escapeHtml(title)}</title>
<style>${inline(css)}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="${DATA_ID}">${data}</script>
<script>${inline(js)}</script>
</body>
</html>
${comment(notices.licences.flatMap(({ covers, text }, i) => [...(i ? ['', '='.repeat(72), ''] : []), ...covers, '', text]))}
`;
}

/** `lines` as an HTML comment. */
function comment(lines: string[]): string {
  // Nothing in it may close the comment, and HTML forbids `--` inside one: split every pair of
  // dashes, so a rule of them (the OFL opens with one) keeps none.
  return `<!--\n${lines.join('\n').replace(/-(?=-)/g, '- ')}\n-->`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
