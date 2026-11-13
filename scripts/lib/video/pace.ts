// Page helpers for the demo videos, paced for a viewer rather than a test.
import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const VIEWPORT = { width: 1600, height: 1000 };
// Capturing a 2x frame takes longer than a video frame lasts, so each scene plays SLOW times slower
// than written (pauses, typing, CSS animations, the page's timers) and the encode speeds it back up.
export const SLOW = Number(process.env.SLOW ?? 3);

export const pause = (page: Page, ms: number) => page.waitForTimeout(ms * SLOW);

const START = { x: VIEWPORT.width * 0.6, y: VIEWPORT.height * 0.55 };
let pointer = START;
export async function glide(page: Page, x: number, y: number, steps = 28) {
  await page.mouse.move(x, y, { steps: steps * SLOW });
  pointer = { x, y };
}

/** Put the pointer back where every scene starts. */
export async function homePointer(page: Page) {
  pointer = START;
  await page.mouse.move(pointer.x, pointer.y);
}

export function fileItem(page: Page, path: string) {
  return page
    .locator('diffs-container')
    .filter({ has: page.locator(`[slot="header-custom"] [data-path=${JSON.stringify(path)}]`) })
    .first();
}

/** The file under the cursor; none before the first `J`, unlike the e2e helper's fallback. */
export async function activePath(page: Page) {
  const row = page.locator('file-tree-container [data-item-type="file"][aria-selected="true"]').first();
  return (await row.count()) ? row.getAttribute('data-item-path') : null;
}

/** Walk the cursor to `path` with J, the way a reader moves through the review. */
export async function walkTo(page: Page, path: string) {
  for (let i = 0; i < 12 && (await activePath(page)) !== path; i++) {
    await page.keyboard.press('J');
    await pause(page, 450);
  }
  if ((await activePath(page)) !== path) throw new Error(`could not walk to ${path}`);
  await pause(page, 400);
}

/** The on-screen number cell of new-side `line` in `path`. */
export async function lineCell(page: Page, path: string, line: number) {
  const item = fileItem(page, path);
  await item.locator('[data-column-number]').first().waitFor({ timeout: 15000 });
  const boxes = await item.locator('[data-column-number]').evaluateAll(
    (cells, wanted) =>
      cells
        .filter((c) => c.getAttribute('data-column-number') === wanted)
        .map((c) => c.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0)
        .map(({ x, y, width, height }) => ({ x, y, width, height })),
    String(line),
  );
  // The rightmost cell is the new side's.
  const box = boxes.sort((a, b) => b.x - a.x)[0];
  if (!box) throw new Error(`line ${line} of ${path} is not rendered`);
  return box;
}

/** Drag the number column from `from` to `to`, which opens the composer on that range. */
export async function selectLines(page: Page, path: string, from: number, to: number) {
  const start = await lineCell(page, path, from);
  await glide(page, start.x + start.width / 2, start.y + start.height / 2);
  await pause(page, 250);
  await page.mouse.down();
  const end = await lineCell(page, path, to);
  await glide(page, end.x + end.width / 2, end.y + end.height - 4, 14);
  await page.mouse.up();
  await pause(page, 350);
}

export async function comment(page: Page, text: string) {
  const composer = page.getByPlaceholder('Leave a comment…');
  await composer.waitFor();
  await pause(page, 300);
  await composer.pressSequentially(text, { delay: 28 * SLOW });
  await pause(page, 500);
  await composer.press('Control+Enter');
  await pause(page, 900);
}

/** The 1-based line of `path` in the demo repository holding `text`. */
export function lineOf(repo: string, path: string, text: string) {
  const index = readFileSync(join(repo, path), 'utf8')
    .split('\n')
    .findIndex((line) => line.includes(text));
  if (index === -1) throw new Error(`${path} has no line with ${text}`);
  return index + 1;
}

/**
 * The on-screen box of the first whole-word `word` on the new side of `path`: the right column of a
 * split diff, or the only column of an added file. Measured with a Range over the text, since syntax
 * highlighting can merge a word into a span with its neighbours.
 */
export async function wordBox(page: Page, path: string, word: string) {
  const boxes = await fileItem(page, path)
    .locator('span[data-char]')
    .evaluateAll((spans, word) => {
      const pattern = new RegExp(`\\b${word}\\b`);
      const found: { x: number; y: number; width: number; height: number; right: boolean }[] = [];
      for (const span of spans) {
        const text = span.firstChild;
        if (span.childNodes.length !== 1 || !(text instanceof Text)) continue;
        const match = pattern.exec(text.data);
        if (!match) continue;
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + word.length);
        const { x, y, width, height } = range.getBoundingClientRect();
        const container = span.closest('[data-diff]') ?? span.closest('diffs-container');
        const bounds = container?.getBoundingClientRect();
        const middle = bounds ? bounds.x + bounds.width / 2 : 0;
        if (width > 0 && y >= 0 && y + height <= innerHeight) found.push({ x, y, width, height, right: x >= middle });
      }
      return found.sort((a, b) => a.y - b.y);
    }, word);
  const box = boxes.find((b) => b.right) ?? boxes[0];
  if (!box) throw new Error(`${word} is not on screen in ${path}`);
  return box;
}

/** Rest the pointer on `word`; the viewer arms its tooltip on movement inside the token. */
export async function hoverWord(page: Page, path: string, word: string) {
  const box = await wordBox(page, path, word);
  await glide(page, box.x + 2, box.y + box.height / 2);
  await glide(page, box.x + Math.min(10, box.width - 2), box.y + box.height / 2, 4);
  return box;
}

/** Hover `word` until its tooltip shows `text`. */
export async function hoverUntil(page: Page, path: string, word: string, text: string) {
  const tooltip = page.getByRole('tooltip').filter({ hasText: text });
  // The first hover can land while the server is still opening the document; hover again then.
  for (let attempt = 0; ; attempt++) {
    await hoverWord(page, path, word);
    try {
      await tooltip.waitFor({ timeout: 3000 * SLOW });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await glide(page, pointer.x, pointer.y + 40, 4);
    }
  }
}

/** Step the references list with j until line `line` of `path` is highlighted. */
export async function stepToReference(page: Page, path: string, line: number) {
  const active = () =>
    page.locator('[data-active="true"]').evaluate((row) => ({
      path: row.closest('section')?.querySelector('header')?.textContent ?? '',
      line: Number(row.firstElementChild?.textContent),
    }));
  for (let i = 0; i < 12; i++) {
    const at = await active();
    if (at.path.includes(path) && at.line === line) return;
    await page.keyboard.press('j');
    await pause(page, 700);
  }
  throw new Error(`no reference at ${path}:${line}`);
}

/** Click a button in the symbol menu, e.g. "Go to definition". */
export async function pickFromSymbolMenu(page: Page, title: string) {
  const button = page.locator(`[data-symbol-menu] [title^="${title}"]`);
  await button.waitFor();
  await pause(page, 500);
  const box = await button.boundingBox();
  if (!box) throw new Error(`${title} is not on screen`);
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, 16);
  await pause(page, 250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Glide to the middle of `target` and click it. */
export async function clickOn(page: Page, target: Locator) {
  await target.waitFor();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${target} is not on screen`);
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, 20);
  await pause(page, 250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
