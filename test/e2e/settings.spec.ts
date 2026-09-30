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
