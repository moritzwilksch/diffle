import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchBrowserLifetime } from '../../src/cli/browserLifetime.js';

class FakeClients {
  listener?: (count: number) => void;

  onClientsChanged(listener: (count: number) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  set(count: number): void {
    this.listener?.(count);
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('watchBrowserLifetime', () => {
  it('stops after the last auto-opened browser disconnects', () => {
    const clients = new FakeClients();
    const close = vi.fn();
    const dispose = watchBrowserLifetime(clients, true, close, 1000);

    clients.set(0);
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();

    clients.set(1);
    clients.set(0);
    vi.advanceTimersByTime(999);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledOnce();

    dispose();
    expect(clients.listener).toBeUndefined();
  });

  it('keeps running across a reload and in --no-open mode', () => {
    const clients = new FakeClients();
    const close = vi.fn();
    const dispose = watchBrowserLifetime(clients, true, close, 1000);
    clients.set(1);
    clients.set(0);
    vi.advanceTimersByTime(500);
    clients.set(1);
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
    dispose();

    const manualClients = new FakeClients();
    watchBrowserLifetime(manualClients, false, close, 1000);
    expect(manualClients.listener).toBeUndefined();
    manualClients.set(1);
    manualClients.set(0);
    vi.advanceTimersByTime(1000);
    expect(close).not.toHaveBeenCalled();
  });
});
