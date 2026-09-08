import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal WebSocket stand-in: the test opens, delivers and closes it by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.onclose?.();
  }
}

const { connectWs } = await import('../../src/client/api.js');

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:1' });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('connectWs', () => {
  it('resyncs on every connection, so state changed while the socket was down is caught up', () => {
    const onMessage = vi.fn();
    const onOpen = vi.fn();
    const stop = connectWs(onMessage, onOpen);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:1/ws');
    // Nothing is fetched before the socket is subscribed: the first open is the boot.
    expect(onOpen).not.toHaveBeenCalled();
    FakeWebSocket.instances[0]!.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    FakeWebSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ type: 'threads' }) });
    expect(onMessage).toHaveBeenLastCalledWith({ type: 'threads' });

    // The server goes away; the repository and comments change meanwhile; no push can arrive.
    FakeWebSocket.instances[0]!.onclose?.();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(2);

    // Stopping closes the socket without reconnecting.
    stop();
    vi.advanceTimersByTime(20_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
