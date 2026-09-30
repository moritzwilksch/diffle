// Binary images drawn as images: the logo refresh on the feature branch (128x96 to 96x96) in each
// comparison, the logo's first commit as one side, and a truncated logo in the worktree that no
// browser decodes. Judge changes in the screenshots under `__snapshots__/images.spec.ts/`.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { gotoFile, settle } from './browser.js';

const LOGO = 'assets/logo.png';

/** The logo's image view, once every side it shows has decoded or failed. */
async function openLogo(page: Page) {
  await gotoFile(page, LOGO);
  const view = page.locator('[data-image-diff]');
  await expect(view.getByText('Loading image…')).toHaveCount(0);
  return view;
}

const compare = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Image comparison' }).getByRole('button', { name });

test.describe('a resized image', () => {
  test('shows both sides next to each other at their natural sizes', async ({ page }) => {
    const view = await openLogo(page);
    await expect(view.getByText('Old · 128 × 96')).toBeVisible();
    await expect(view.getByText('New · 96 × 96')).toBeVisible();
    await expect(view).toMatchAriaSnapshot({ name: 'side-by-side.aria.yml' });
    await expect(view).toHaveScreenshot('side-by-side.png');
  });

  test('swipes between the sides on one canvas, dividing where the pointer drags', async ({ page }) => {
    const view = await openLogo(page);
    await compare(page, 'Swipe').click();
    const stack = view.locator('[data-stack="swipe"]');
    const box = (await stack.boundingBox())!;
    // Drag past the narrower new side's right edge: the divider follows the canvas, not the image.
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(stack.locator('[data-layer="new"]')).toHaveAttribute('style', /inset\(0px 0px 0px 30%\)/);
    await expect(view).toHaveScreenshot('swipe.png');
  });

  test('fades the new side over the old one in onion skin', async ({ page }) => {
    const view = await openLogo(page);
    await compare(page, 'Onion skin').click();
    await view.getByRole('slider', { name: 'New side opacity' }).fill('30');
    await expect(view.locator('[data-stack="onion"] [data-layer="new"]')).toHaveCSS('opacity', '0.3');
    await expect(view).toHaveScreenshot('onion.png');
  });

  test('shows the pixel difference and keeps that choice across a reload', async ({ page }) => {
    let view = await openLogo(page);
    await compare(page, 'Difference').click();
    await expect(view.getByText('Unchanged pixels are black.')).toBeVisible();
    await expect(view).toHaveScreenshot('difference.png');

    await page.reload();
    await settle(page);
    view = await openLogo(page);
    await expect(compare(page, 'Difference')).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('[data-stack="difference"]')).toBeVisible();
  });
});

test.describe('an added image', () => {
  test.use({ revs: ['v0.1.0..main'] });

  test('shows its one side with nothing to compare', async ({ page }) => {
    const view = await openLogo(page);
    await expect(view.getByRole('img')).toHaveCount(1);
    await expect(page.getByRole('group', { name: 'Image comparison' })).toHaveCount(0);
    await expect(view).toHaveScreenshot('added.png');
  });
});

test.describe('an image that does not decode', () => {
  test.use({ revs: ['working'] });

  test('falls back to side by side with a note, the comparisons disabled', async ({ page }) => {
    const view = await openLogo(page);
    await expect(view.getByText('Binary file: not a displayable image')).toBeVisible();
    await expect(view.getByRole('img')).toHaveCount(1);
    for (const name of ['Swipe', 'Onion skin', 'Difference']) await expect(compare(page, name)).toBeDisabled();
    await expect(view).toHaveScreenshot('undecodable.png');
  });
});
