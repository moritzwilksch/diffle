import { existsSync } from 'node:fs';
import { ensureBrowserServer } from './browser-server.js';
import { diffleCommand } from './server.js';

/**
 * The suite drives the release binary, which embeds `crates/diffle/client`; `pixi run e2e` builds
 * both first, and `DIFFLE_BIN=<path>` names another build. Then make sure the browser container
 * answers; the teardown stops what this started.
 */
export default async function globalSetup(): Promise<void> {
  const [binary] = diffleCommand();
  if (!existsSync(binary!)) throw new Error(`${binary} is not built; run \`pixi run e2e\`, which builds it first`);
  if (await ensureBrowserServer()) process.env.DIFFLE_BROWSER_STARTED = '1';
}
