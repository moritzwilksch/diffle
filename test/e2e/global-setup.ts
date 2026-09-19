import { buildClient } from './harness.js';

/**
 * The server serves `dist/client`, so the screenshots show whatever was built last. Build it
 * from the current sources before every run rather than trusting a stale build.
 */
export default function globalSetup(): void {
  if (process.env.DIFFLE_E2E_SKIP_BUILD) return;
  buildClient();
}
