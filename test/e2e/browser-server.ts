// The browser the suite and the capture scripts drive: Playwright's Chromium in its Linux image,
// served over WebSocket from a container (compose.yml), so screenshots match CI on every host. The
// runner, the fixture repositories and diffle itself run natively; the browser reaches them through
// Playwright's loopback tunnel (`exposeNetwork`), so each diffle stays on 127.0.0.1 and its origin
// guard sees a local Host.
import { chromium, type ConnectOptions } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The image and the server inside it follow the installed `@playwright/test`: a client only talks to its own version. */
export const PLAYWRIGHT_VERSION: string = createRequire(import.meta.url)('@playwright/test/package.json').version;
const PORT = process.env.DIFFLE_BROWSER_PORT ?? '3000';
/** How long the server may take to answer once its container runs; it needs no network, so seconds. */
const START_TIMEOUT_MS = 60_000;

/** Where the browser server listens. `DIFFLE_BROWSER_WS` names one started elsewhere. */
export function wsEndpoint(): string {
  return process.env.DIFFLE_BROWSER_WS ?? `ws://127.0.0.1:${PORT}/`;
}

/** How the runner and the scripts connect: the host's loopback is reachable from inside the browser. */
export function connectOptions(): ConnectOptions & { wsEndpoint: string } {
  return { wsEndpoint: wsEndpoint(), exposeNetwork: '<loopback>' };
}

/** Whether the server answers right now: one short-lived browser, closed again. */
async function answers(timeout: number): Promise<boolean> {
  try {
    const browser = await chromium.connect(wsEndpoint(), { timeout });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

function compose(...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('docker', ['compose', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_VERSION, DIFFLE_BROWSER_PORT: PORT },
  });
}

/**
 * Makes sure a browser server answers at `wsEndpoint()`, starting the container when nothing does.
 * Returns whether this call started it, so the caller stops only what it started: a server named
 * by `DIFFLE_BROWSER_WS` or left running from an earlier `docker compose up` is someone else's.
 */
export async function ensureBrowserServer(): Promise<boolean> {
  if (await answers(3000)) return false;
  if (process.env.DIFFLE_BROWSER_WS) {
    throw new Error(`no Playwright ${PLAYWRIGHT_VERSION} browser server answers at ${wsEndpoint()}`);
  }
  const up = compose('up', '--detach', '--quiet-pull', 'browser');
  if (up.error || up.status !== 0) {
    const why = up.error?.message ?? `${up.stdout}${up.stderr}`.trim().split('\n').slice(-8).join('\n');
    throw new Error(
      `could not start the browser container (compose.yml): ${why}\nInstall and start Docker, then retry.`,
    );
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await answers(5000))) {
    // A server that died will not come back; its log is the only record of why, and stopping loses it.
    const exited = compose('ps', '--all', '--format', '{{.State}}', 'browser').stdout?.toString().trim() === 'exited';
    if (exited || Date.now() > deadline) {
      const log = compose('logs', '--no-color', '--tail', '20', 'browser').stdout?.toString().trim();
      stopBrowserServer();
      const why = exited ? 'exited' : `did not answer within ${START_TIMEOUT_MS / 1000}s`;
      throw new Error(`the browser server ${why}; its log:\n${log || '(empty)'}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

/** Stops the container; a failure here is not worth failing a passed run for. */
export function stopBrowserServer(): void {
  compose('stop', '--timeout', '5', 'browser');
}
