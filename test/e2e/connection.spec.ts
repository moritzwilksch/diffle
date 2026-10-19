// The page outlives its server: stopping diffle says so, and a diffle restarted on the same port
// takes the page back without a reload.
import { expect, test } from './fixtures.js';
import { startDiffle } from './server.js';

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
