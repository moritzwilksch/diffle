import { ensureBrowserServer } from './browser-server.js';
import { buildClient, buildServer } from './server.js';

/**
 * The release binary embeds `dist/client`, so the screenshots show whatever was built last. Build
 * the client, then the binary, from the current sources before every run; cargo rebuilds only
 * what changed. Then make sure the browser container answers; the teardown stops what this started.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env.DIFFLE_E2E_SKIP_BUILD) {
    buildClient();
    if (!process.env.DIFFLE_BIN) buildServer();
  }
  if (await ensureBrowserServer()) process.env.DIFFLE_BROWSER_STARTED = '1';
}
