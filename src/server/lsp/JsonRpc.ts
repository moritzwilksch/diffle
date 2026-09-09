import type { Readable, Writable } from 'node:stream';

/** JSON-RPC 2.0 over a byte stream with `Content-Length` framing (the LSP base protocol). No LSP semantics. */
export class JsonRpcConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }
  >();
  private handlers = new Set<(method: string, params: unknown) => void>();
  private buffer: Buffer = Buffer.alloc(0);
  private disposed: Error | null = null;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.on('data', (chunk: Buffer) => this.onData(chunk));
    // A server that dies mid-request turns the next write into EPIPE; unhandled, that
    // would take the whole process down.
    input.on('error', (e: Error) => this.dispose(e));
    output.on('error', (e: Error) => this.dispose(e));
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.disposed) return Promise.reject(this.disposed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Server → client notifications and requests (requests get an empty success reply). */
  onNotification(handler: (method: string, params: unknown) => void): void {
    this.handlers.add(handler);
  }

  /** Rejects every pending request and ignores further traffic. */
  dispose(reason: Error): void {
    if (this.disposed) return;
    this.disposed = reason;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  private send(msg: object): void {
    if (this.disposed || this.output.destroyed) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.output.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('latin1');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Unparseable frame: drop the header and resync on the next one.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      this.onMessage(body);
    }
  }

  private onMessage(body: string): void {
    let msg: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    if (msg.method != null) {
      for (const h of this.handlers) h(msg.method, msg.params);
      // Server → client requests (e.g. workDoneProgress/create, client/registerCapability): acknowledge.
      if (msg.id != null) this.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
}
