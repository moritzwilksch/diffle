// Shutdown closes tabs the browser allows scripts to close; other tabs can reconnect.
import { expect, test } from './fixtures.js';
import { startDiffle } from './server.js';

test('closes a script-opened tab when the server exits', async ({ page, diffle }) => {
  const popupPromise = page.waitForEvent('popup');
  await page.evaluate((url) => window.open(url), diffle.url);
  const popup = await popupPromise;
  await expect(popup.locator('header')).toContainText('17 files');

  const closed = popup.waitForEvent('close');
  await diffle.stop();
  await closed;
  expect(popup.isClosed()).toBe(true);
});

test('warns while the server is gone and recovers when it returns', async ({ page, diffle, repo, revs }) => {
  const banner = page.getByRole('alert');
  await expect(banner).toHaveCount(0);

  await diffle.stop();
  await expect(banner).toBeVisible();
  await expect(page).toHaveScreenshot('server-lost.png');
  await expect(banner).toMatchAriaSnapshot({ name: 'server-lost.aria.yml' });

  const restarted = await startDiffle({ repo, revs, args: ['--port', new URL(diffle.url).port] });
  try {
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('header')).toContainText('17 files');
  } finally {
    await restarted.stop();
  }
});
