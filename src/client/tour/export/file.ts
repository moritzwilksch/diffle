import { api } from '@/client/api.js';
import type { ExportNotices } from '@/shared/notices.js';
import { readTour } from '@/client/tour/document.js';
import type { TourLoad } from '@/client/tour/state.js';
import type { TourExportAnswer } from '@/shared/tour.js';
import { bakeTour } from './bake.js';
import { type BakedTour, DATA_ID } from './data.js';

type Ready = Extract<TourLoad, { state: 'ready' }>;

/**
 * Saves the tour `load` as one HTML file named after its title: the tour as the review shows it
 * now, readable offline in either theme.
 */
export async function exportTour(load: Ready): Promise<void> {
  const { name, html } = await tourExport(load);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Answers the server's request `id` with the review's tour as one file, for `diffle tour export`;
 * a failure is the answer too, so the command need not wait for its timeout.
 */
export async function answerExport(id: string): Promise<void> {
  let answer: TourExportAnswer;
  try {
    const { tour } = await api.tour();
    if (!tour) throw new Error('the review has no tour');
    const { html } = await tourExport({ state: 'ready', tour, doc: readTour(tour.html) });
    answer = { type: 'baked', html };
  } catch (e) {
    answer = { type: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
  // A 404 means another tab answered first, or the command gave up.
  await api.answerTourExport(id, answer).catch(() => undefined);
}

/**
 * The tour `load` as the review shows it now, baked into one HTML file with its script and styles
 * inlined, and the file's name from its title. Its policy lets it load nothing but what it holds.
 */
async function tourExport(load: Ready): Promise<{ name: string; html: string }> {
  const [baked, runtime] = await Promise.all([bakeTour(load), api.tourRuntime()]);
  // A client built without the export answers with its page instead.
  if (runtime.js.trimStart().startsWith('<')) throw new Error('this build of diffle cannot export tours');
  const title = load.doc.title ?? 'Tour';
  const notices = JSON.parse(runtime.notices) as ExportNotices;
  return { name: exportName(load.doc.title), html: tourFile(baked, title, { ...runtime, notices }) };
}

/** The longest an exported tour's name runs before `.html`. */
const NAME_LENGTH = 40;

/**
 * The file name an exported tour downloads as: its title's words, lowercased and hyphenated, as many
 * whole ones as fit in `NAME_LENGTH`; `diffle-tour` for a title without any.
 */
export function exportName(title: string | null | undefined): string {
  let name = '';
  for (const word of title?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const longer = name ? `${name}-${word}` : word;
    if (longer.length > NAME_LENGTH) {
      // A first word longer than the cap is cut, not dropped.
      if (!name) name = word.slice(0, NAME_LENGTH);
      break;
    }
    name = longer;
  }
  return `${name || 'diffle-tour'}.html`;
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
