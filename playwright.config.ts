import { defineConfig } from '@playwright/test';
import { connectOptions } from './test/e2e/browser-server.js';

/**
 * End-to-end tests: a real diffle over the fixture repository in a real Chromium, judged by
 * screenshots and accessibility snapshots committed under `test/e2e/__snapshots__/`.
 *
 * Screenshots are pixel-exact only on one platform and font stack, so the browser is always
 * Playwright's Linux Chromium, served from a container (`compose.yml`, started by the global
 * setup), while the runner and diffle run natively; `pixi run e2e --update-snapshots` regenerates them.
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  // One directory per spec, one file per scenario; no platform suffix, since the browser is the
  // same everywhere.
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}{ext}',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    connectOptions: connectOptions(),
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
