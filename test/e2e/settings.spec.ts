import { expect, expectAria, test } from './fixtures.js';

test('opens the keyboard help', async ({ page }) => {
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveScreenshot('help.png');
  await expectAria(dialog, 'help');
});

test('opens the mode picker on the current comparison', async ({ page }) => {
  await page.keyboard.press('m');
  const picker = page.locator('#mode-picker');
  await expect(picker).toBeVisible();
  await expect(page).toHaveScreenshot('mode-picker.png');
  await expectAria(picker, 'mode-picker');
});

test('masks the version in the settings dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The version changes with every release; everything else in the dialog is stable.
  await expect(page).toHaveScreenshot('settings.png', { mask: [page.getByTitle('Installed diffle version')] });
});
