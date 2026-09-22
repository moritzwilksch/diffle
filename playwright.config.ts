import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: a real diffle over the fixture repository in a real Chromium, judged by
 * screenshots and accessibility snapshots committed under `test/e2e/__snapshots__/`.
 *
 * Screenshots are pixel-exact only on one platform and font stack, so they are committed for
 * Linux alone and CI runs them there; `npm run test:e2e:update` regenerates them.
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  // One directory per spec, one file per scenario and colour scheme; no platform suffix, since only
  // Linux screenshots are committed.
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}.{projectName}{ext}',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'light', use: { colorScheme: 'light' } },
    { name: 'dark', use: { colorScheme: 'dark' } },
  ],
});
