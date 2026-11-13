// The tour scene: an agent's tour of the change (`demo-tour.ts`), read the way a reviewer would.
import type { Locator, Page } from '@playwright/test';
import { DEMO_TOUR } from '../demo-tour.js';
import { SLOW, clickOn, glide, pause } from './pace.js';

async function pushTour(url: string) {
  const response = await fetch(new URL('api/tour', url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html: DEMO_TOUR }),
  });
  if (!response.ok) throw new Error(`pushing the tour failed: HTTP ${response.status} ${await response.text()}`);
}

/**
 * Wheel the tour's page until `target`'s top sits `at` (a fraction of the viewport) or the page
 * ends. Either way: taking a late section can leave the page at its bottom, past the target.
 */
async function scrollTo(page: Page, view: Locator, target: Locator, at = 0.2) {
  const article = (await view.locator('article').boundingBox())!;
  await glide(page, article.x + article.width * 0.5, page.viewportSize()!.height * 0.6, 16);
  const scroller = view.locator('.tour-layout').locator('..');
  for (let i = 0; i < 80; i++) {
    const top = (await target.boundingBox())!.y;
    const left = top - page.viewportSize()!.height * at;
    if (Math.abs(left) <= 4) return;
    const before = await scroller.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, Math.sign(left) * Math.min(36, Math.abs(left)));
    await page.waitForTimeout(28 * SLOW);
    if ((await scroller.evaluate((el) => el.scrollTop)) === before) return;
  }
}

/** Drag across `words` in the article, as a reader selecting them would. */
async function selectWords(page: Page, view: Locator, words: string) {
  const box = await view.locator('article').evaluate((article, words) => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent!.indexOf(words);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + words.length);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    }
    throw new Error(`"${words}" is not in the tour`);
  }, words);
  await glide(page, box.x + 1, box.y + box.height / 2, 18);
  await pause(page, 200);
  await page.mouse.down();
  await glide(page, box.x + box.width - 1, box.y + box.height / 2, 20);
  await page.mouse.up();
  await pause(page, 500);
}

async function type(page: Page, view: Locator, text: string) {
  const composer = view.getByPlaceholder('Leave a comment…');
  await composer.waitFor();
  await pause(page, 300);
  await composer.pressSequentially(text, { delay: 28 * SLOW });
  await pause(page, 500);
  await composer.press('Control+Enter');
  await pause(page, 1200);
}

// Sections are reached by wheel, not `n`: a jump reads as a cut, and `n` to the last section lands at the
// page's bottom, past what comes next.
const heading = (view: Locator, name: string) => view.getByRole('heading', { level: 2, name });

async function press(page: Page, key: string, wait: number) {
  await page.keyboard.press(key);
  await pause(page, wait);
}

/** Open the tour, step its diagram and walk, look up a symbol, comment, and answer its checklist. */
export async function tour(page: Page, url: string) {
  await pushTour(url);
  await pause(page, 900);
  const view = page.getByRole('region', { name: 'Tour view' });
  // The push reaches the page over its socket; until then T says there is no tour.
  for (let i = 0; !(await view.isVisible()); i++) {
    if (i === 20) throw new Error('the tour never showed');
    await page.keyboard.press('T');
    await pause(page, 300);
  }
  await view.getByText('Loading…').waitFor({ state: 'detached' });
  await pause(page, 1800);

  // Where to start: the trees, then the request's trip, one step at a time.
  const diagram = view.locator('figure[data-stepped]');
  await scrollTo(page, view, diagram, 0.18);
  await pause(page, 800);
  for (let i = 0; i < 4; i++) await press(page, 'l', 1500);

  // The token bucket: a symbol's references, then the walk.
  await scrollTo(page, view, heading(view, 'The token bucket'), 0.12);
  await pause(page, 1400);
  await clickOn(page, view.getByRole('button', { name: 'RateLimiter' }));
  const references = page.getByRole('dialog', { name: 'References' });
  await references.waitFor();
  await pause(page, 1800);
  await press(page, 'Escape', 800);
  const walk = view.locator('figure[data-walk]');
  await scrollTo(page, view, walk, 0.12);
  await pause(page, 600);
  for (let i = 0; i < 4; i++) await press(page, 'l', 1400);

  // A comment on the callout's words lands in the margin.
  const callout = view.getByRole('complementary', { name: 'warning' });
  await scrollTo(page, view, callout, 0.35);
  await selectWords(page, view, 'drains the bucket');
  await press(page, 'c', 300);
  await type(page, view, 'Use time.monotonic(), which never goes back.');
  await scrollTo(page, view, view.locator('figure').filter({ hasText: 'retry_after' }).last(), 0.45);
  await pause(page, 1400);

  // The handler: a trace from stop to stop, then the alternatives in tabs.
  await scrollTo(page, view, heading(view, 'The handler answers 429'), 0.12);
  await pause(page, 1600);
  const trace = view.locator('figure[data-trace]');
  await scrollTo(page, view, trace, 0.15);
  await pause(page, 900);
  for (const stop of [2, 3, 4]) {
    await clickOn(page, trace.getByRole('button', { name: new RegExp(`^Stop ${stop}`) }));
    await pause(page, 1300);
  }
  const tabs = view.locator('.tour-tabs');
  await scrollTo(page, view, tabs, 0.3);
  await pause(page, 900);
  for (const name of [/Rounded up/, /The response/]) {
    await clickOn(page, tabs.getByRole('tab', { name }));
    await pause(page, 1300);
  }

  // The rest: a folded aside, and the questions to settle before merging.
  const aside = view.locator('details summary');
  await scrollTo(page, view, aside, 0.3);
  await pause(page, 1000);
  await clickOn(page, aside);
  await pause(page, 1600);
  const check = view.getByRole('region', { name: 'Checklist' });
  await scrollTo(page, view, check, 0.3);
  await pause(page, 600);
  await clickOn(page, check.getByRole('checkbox', { name: /round up/ }));
  await pause(page, 900);
  await clickOn(
    page,
    check.getByRole('listitem').filter({ hasText: 'x-forwarded-for' }).getByRole('button', { name: 'Answer' }),
  );
  await type(page, view, 'No: key on the socket address unless a trusted proxy sets it.');
  // Rest the pointer off the article, where hovering a block would show its Comment button.
  await glide(page, page.viewportSize()!.width * 0.08, page.viewportSize()!.height * 0.7);
  await pause(page, 1500);
}
