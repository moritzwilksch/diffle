import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

// The tree ellipsizes long names while lines wrap; `zw` unwraps them and turns on the sideways scroll. Then,
// narrower than its widest row, the pane scrolls, and the counts, viewed mark and git status stay
// pinned to its right edge, within reach of the pointer.
test.beforeEach(async ({ page }) => {
  // Drag the divider as far left as the pane goes.
  const box = (await page.getByTitle('Drag to resize').first().boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 300, box.y + 200, { steps: 6 });
  await page.mouse.up();
});

const scrollsSideways = (page: Page) =>
  page
    .locator('file-tree-container [data-file-tree-virtualized-scroll]')
    .evaluate((el) => el.scrollWidth > el.clientWidth);

async function scrollLongNames(page: Page) {
  await page.keyboard.press('z');
  await page.keyboard.press('w');
  await expect.poll(() => scrollsSideways(page)).toBe(true);
}

test('a narrow sidebar scrolls sideways and keeps the lanes in view', async ({ page }) => {
  await scrollLongNames(page);
  const pane = page.locator('file-tree-container [data-file-tree-virtualized-scroll]');
  await expect.poll(() => pane.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  const strayLanes = () =>
    pane.evaluate((el) => {
      const view = el.getBoundingClientRect();
      const right = view.left + el.clientWidth;
      return Array.from(el.querySelectorAll('[data-item-section="decoration"], [data-item-section="git"]')).filter(
        (lane) => {
          const box = lane.getBoundingClientRect();
          return box.left < view.left - 0.5 || box.right > right + 0.5;
        },
      ).length;
    });
  for (const left of [0, 60, 10_000]) {
    await pane.evaluate((el, x) => (el.scrollLeft = x), left);
    expect(await strayLanes(), `scrolled to ${left}`).toBe(0);
  }

  await pane.evaluate((el) => (el.scrollLeft = 60));
  await page.mouse.move(600, 400);
  await expect(page.locator('file-tree-container')).toHaveScreenshot('narrow-tree.png');
});

test('the lanes stand in the same column whether names scroll or ellipsize', async ({ page }) => {
  const laneEdges = () =>
    page
      .locator('file-tree-container [data-item-path="tally/cli.py"]')
      .evaluate((row) =>
        ['decoration', 'git'].map((s) =>
          Math.round(row.querySelector(`[data-item-section="${s}"] > span`)!.getBoundingClientRect().right),
        ),
      );
  const ellipsized = await laneEdges();
  await scrollLongNames(page);
  expect(await laneEdges()).toEqual(ellipsized);
});

test('an unchanged row pins no lanes over its name', async ({ page }) => {
  await scrollLongNames(page);
  await page.getByRole('button', { name: 'All files' }).click();
  await page.locator('file-tree-container [data-item-path="docs/"]').click({ position: { x: 20, y: 10 } });
  const row = page.locator('file-tree-container [data-item-path="docs/release notes.md"]');
  const pane = page.locator('file-tree-container [data-file-tree-virtualized-scroll]');
  await pane.evaluate((el) => (el.scrollLeft = 10_000));
  // Nothing is left to cover the name, so it ends inside the pane.
  await expect(row.locator('[data-item-section="decoration"], [data-item-section="git"]')).toHaveCount(2);
  await expect(row.locator('[data-item-section="decoration"]')).toBeHidden();
  await expect(row.locator('[data-item-section="git"]')).toBeHidden();
  const ends = await row.evaluate((el) => {
    const name = el.querySelector('[data-item-section="content"]')!.getBoundingClientRect();
    const view = el.closest('[data-file-tree-virtualized-scroll]')!;
    return name.right <= view.getBoundingClientRect().left + view.clientWidth;
  });
  expect(ends).toBe(true);
});

test('a clipped row names its full path', async ({ page }) => {
  await scrollLongNames(page);
  const row = page.locator('file-tree-container [data-item-path="tally/generated/openapi.py"]');
  await row.hover({ position: { x: 70, y: 13 } });
  await expect(page.getByRole('tooltip')).toHaveText('tally/generated/openapi.py');
});

test('the tree ellipsizes while lines wrap, unwrapping trades that for the scroll, and the choice sticks', async ({
  page,
}) => {
  await expect.poll(() => scrollsSideways(page)).toBe(false);
  await page.mouse.move(600, 400);
  await expect(page.locator('file-tree-container')).toHaveScreenshot('narrow-tree-ellipsis.png');

  // An ellipsized name still offers its full path.
  await page
    .locator('file-tree-container [data-item-path="tally/generated/openapi.py"]')
    .hover({ position: { x: 70, y: 13 } });
  await expect(page.getByRole('tooltip')).toHaveText('tally/generated/openapi.py');

  await scrollLongNames(page);
  await page.reload();
  await expect.poll(() => scrollsSideways(page)).toBe(true);
});

test('a tooltip follows the pointer down the rows without waiting again', async ({ page }) => {
  await scrollLongNames(page);
  const pane = page.locator('file-tree-container [data-file-tree-virtualized-scroll]');
  await pane.evaluate((el) => (el.scrollLeft = 10_000));
  const tooltip = page.getByRole('tooltip');
  const row = (path: string) => page.locator(`file-tree-container [data-item-path="${path}"]`);
  await row('scripts/').hover({ position: { x: 60, y: 13 } });
  await expect(tooltip).toHaveText('scripts');
  // The pointer-rest delay is 250ms; the next row's tip must beat it.
  await row('tests/').hover({ position: { x: 60, y: 13 } });
  await expect(tooltip).toHaveText('tests', { timeout: 200 });
});

test('a narrow toolbar drops the count and keeps its buttons in reach', async ({ page }) => {
  const bar = page.locator('aside.tree-theme > div').first();
  const fits = () => bar.evaluate((el) => el.scrollWidth <= el.clientWidth);
  const count = bar.getByText('17', { exact: true });
  const dragTo = async (offset: number) => {
    const divider = (await page.getByTitle('Drag to resize').first().boundingBox())!;
    await page.mouse.move(divider.x + 2, divider.y + 200);
    await page.mouse.down();
    await page.mouse.move(divider.x + 2 + offset, divider.y + 200, { steps: 4 });
    await page.mouse.up();
    // The tooltip lifts the divider's title while the pointer rests on it; leave so the next drag finds it.
    await page.mouse.move(700, 400);
  };

  await dragTo(42);
  await expect.poll(fits).toBe(true);
  await expect(count).toBeHidden();

  await dragTo(100);
  await expect.poll(fits).toBe(true);
  await expect(count).toBeVisible();
});
