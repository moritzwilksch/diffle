import { buildClient, buildServer } from './server.js';

/**
 * The release binary embeds `dist/client`, so the screenshots show whatever was built last. Build
 * the client, then the binary, from the current sources before every run; cargo rebuilds only
 * what changed.
 */
export default function globalSetup(): void {
  if (process.env.DIFFLE_E2E_SKIP_BUILD) return;
  buildClient();
  if (!process.env.DIFFLE_BIN) buildServer();
}
