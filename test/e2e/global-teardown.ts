import { stopBrowserServer } from './browser-server.js';

/** Stops the browser container when the setup started it; one left running by hand stays. */
export default function globalTeardown(): void {
  if (process.env.DIFFLE_BROWSER_STARTED) stopBrowserServer();
}
