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
  vi.stubGlobal('location', new URL('http://localhost:1/'));
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

describe('proxy paths', () => {
  it.each([
    ['http://localhost:1/', 'http://localhost:1/', 'ws://localhost:1/ws'],
    ['https://proxy:8080/diffle/', 'https://proxy:8080/diffle/', 'wss://proxy:8080/diffle/ws'],
    ['https://proxy/review/diffle/?q=1#file', 'https://proxy/review/diffle/', 'wss://proxy/review/diffle/ws'],
    ['https://proxy/diffle/index.html', 'https://proxy/diffle/', 'wss://proxy/diffle/ws'],
  ])('keeps JSON, text, mutations and reconnects under %s', async (page, base, socket) => {
    vi.stubGlobal('location', new URL(page));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('[]'))
      .mockResolvedValueOnce(new Response('patch'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('../../src/client/api.js');
    await api.threads();
    await api.patch('a & b.txt');
    await api.deleteThread('id/with slash');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${base}api/threads?`,
      `${base}api/patch?path=a+%26+b.txt`,
      `${base}api/threads/id%2Fwith%20slash`,
    ]);
    expect(fetch.mock.calls[2]![1]).toMatchObject({ method: 'DELETE' });
    const stop = connectWs(vi.fn(), vi.fn());
    expect(FakeWebSocket.instances[0]!.url).toBe(socket);
    FakeWebSocket.instances[0]!.onclose?.();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances[1]!.url).toBe(socket);
    stop();
  });
});

describe('api validation', () => {
  it('validates response fields instead of trusting the requested type', async () => {
    const { api } = await import('../../src/client/api.js');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: 'a.txt', contents: 3, binary: false }))),
    );
    await expect(api.file('a.txt', 'new')).rejects.toThrow(/contents/);
  });

  it('accepts valid JSON and empty delete responses', async () => {
    const { api } = await import('../../src/client/api.js');
    const file = { path: 'a.txt', contents: 'hello', binary: false };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(file)))
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    await expect(api.file('a.txt', 'new')).resolves.toEqual(file);
    await expect(api.deleteThread('id')).resolves.toBeUndefined();
    await expect(api.deleteMessage('id', 'mid')).resolves.toBeUndefined();
  });

  it('rejects an unexpected empty response and preserves useful HTTP errors', async () => {
    const { api } = await import('../../src/client/api.js');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'missing file' }), { status: 404 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 42 }), { status: 502, statusText: 'Bad Gateway' })),
    );
    await expect(api.file('a.txt', 'new')).rejects.toThrow();
    await expect(api.file('a.txt', 'new')).rejects.toMatchObject({ status: 404, message: 'missing file' });
    await expect(api.file('a.txt', 'new')).rejects.toMatchObject({ status: 502, message: 'Bad Gateway' });
  });

  it('validates outgoing bodies before fetching', async () => {
    const { api } = await import('../../src/client/api.js');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(() => api.lspDefinition({ path: 'a.ts', line: 1.5, col: 0 })).toThrow(/line/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores valid JSON with invalid WebSocket message shapes', () => {
    const onMessage = vi.fn();
    const stop = connectWs(onMessage, vi.fn());
    const ws = FakeWebSocket.instances[0]!;
    for (const msg of [
      null,
      {},
      { type: 'unknown' },
      { type: 'snapshot', version: '1' },
      { type: 'lsp', payload: {} },
    ]) {
      ws.onmessage?.({ data: JSON.stringify(msg) });
    }
    expect(onMessage).not.toHaveBeenCalled();
    ws.onmessage?.({ data: JSON.stringify({ type: 'snapshot', version: 2 }) });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ type: 'snapshot', version: 2 });
    stop();
  });
});
