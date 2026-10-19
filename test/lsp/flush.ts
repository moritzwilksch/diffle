import type { Writable } from 'node:stream';
import { expect } from 'vitest';

let marks = 0;

/**
 * Resolves once the fake server has logged every event sent to it before the call, so
 * a test can assert both what arrived and what did not. Notifications have no reply to await.
 */
export async function flush(child: { stdin: Writable }, log: string[]): Promise<void> {
  const mark = `mark ${++marks}`;
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'test/mark', params: { mark } }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
  await expect.poll(() => log).toContain(mark);
  log.splice(log.indexOf(mark), 1);
}
