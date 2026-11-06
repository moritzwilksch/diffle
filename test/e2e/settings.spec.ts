import type { Page } from '@playwright/test';
import { activePath, gotoFile } from './browser.js';
import { expect, test } from './fixtures.js';

test('opens the keyboard help', async ({ page }) => {
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveScreenshot('help.png');
  await expect(dialog).toMatchAriaSnapshot({ name: 'help.aria.yml' });
});

test('opens the mode picker on the current comparison', async ({ page }) => {
  await page.keyboard.press('m');
  const picker = page.locator('#mode-picker');
  await expect(picker).toBeVisible();
  await expect(page).toHaveScreenshot('mode-picker.png');
  await expect(picker).toMatchAriaSnapshot({ name: 'mode-picker.aria.yml' });
});

test('masks the version in the settings dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The version changes with every release; its label stretches to the buttons, so the mask's width
  // does not depend on the version's length.
  await expect(page).toHaveScreenshot('settings.png', { mask: [page.getByTitle('Installed diffle version')] });
});

test('closes the settings dialog on Escape and on a click outside it', async ({ page }) => {
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
});

/** The number of `path`'s first line below its sticky header: the row a reader's eye is on. */
const topLine = (page: Page, path: string) =>
  page
    .locator('diffs-container')
    .filter({ has: page.locator(`[data-path="${path}"]`) })
    .evaluate((card) => {
      const root = card.shadowRoot!;
      const edge = root.querySelector('[data-diffs-header]')!.getBoundingClientRect().bottom;
      const row = [...root.querySelectorAll('[data-line]')].find((r) => r.getBoundingClientRect().bottom > edge + 1);
      return row?.getAttribute('data-line') ?? null;
    });

test('scales the app to the chosen text size and keeps the diff in place', async ({ page }) => {
  const path = 'tally/ledger.py';
  await gotoFile(page, path);
  // Scroll by wheel: a jump leaves its target in the store, and the viewer lands it again on any relayout.
  await page.locator(`[data-path="${path}"]`).first().hover();
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  const line = await topLine(page, path);
  expect(line).not.toBeNull();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('combobox', { name: 'Text size' }).selectOption('125');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('18px');
  expect(await activePath(page)).toBe(path);
  await expect.poll(() => topLine(page, path)).toBe(line);
  await expect(page).toHaveScreenshot('text-size-125.png');

  // Kept in the browser: a reload opens at the same size.
  await page.reload();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('18px');
});
