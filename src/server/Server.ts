import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { requestGuard } from './guard.js';
import { createApi, type ApiDeps } from './routes.js';

export interface ServerOptions {
  port: number;
  /** When the port is taken, try the following ones (up to PROBE_PORTS) instead of failing. */
  probe?: boolean;
  host: string;
}

/** Default port, chosen to be unassigned and memorable; `--port` overrides it. */
export const DEFAULT_PORT = 4966;
const PROBE_PORTS = 100;
/** JSON bodies are small (comments, viewed marks, config); anything bigger is not a client. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Owns the HTTP server, API mounting, static serving, and the WS upgrade. */
export class Server {
  private http: HttpServer | null = null;

  constructor(
    private readonly deps: ApiDeps,
    private readonly opts: ServerOptions,
  ) {}

  async listen(): Promise<URL> {
    const app = new Hono();
    const guard = requestGuard(this.opts.host);
    app.use('/api/*', async (c, next) => {
      if (!guard({ host: c.req.header('host'), origin: c.req.header('origin') })) return c.json({ error: 'forbidden origin' }, 403);
      await next();
    });
    app.use('/api/*', async (c, next) => {
      const body = c.req.raw.body;
      if (!body) return next();
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      // Drain oversized uploads before replying: closing mid-write gives clients EPIPE, not 413.
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size <= MAX_BODY_BYTES) chunks.push(value);
          else chunks.length = 0;
        }
      } finally {
        reader.releaseLock();
      }
      if (size > MAX_BODY_BYTES) return c.json({ error: 'request body too large' }, 413);
      const init: RequestInit & { duplex: 'half' } = {
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        duplex: 'half',
      };
      c.req.raw = new Request(c.req.raw, init);
      await next();
    });
    app.use('/api/*', compress());
    app.route('/', createApi(this.deps));

    const clientDir = resolveClientDir();
    app.use('*', serveStatic({ root: clientDir }));
    app.get('*', serveStatic({ root: clientDir, path: 'index.html' }));

    this.http = createServer(getRequestListener(app.fetch));
    this.deps.hub.attach(this.http, guard);
    return this.bind();
  }

  /** Listen on the configured port, or with `probe` on the first free port at or above it. */
  private async bind(): Promise<URL> {
    const last = this.opts.probe ? this.opts.port + PROBE_PORTS : this.opts.port;
    for (let port = this.opts.port; ; port++) {
      try {
        return await this.listenOn(port);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port >= last) throw e;
      }
    }
  }

  private listenOn(port: number): Promise<URL> {
    return new Promise<URL>((resolve, reject) => {
      const onError = (e: Error) => {
        this.http!.off('error', onError);
        reject(e);
      };
      this.http!.once('error', onError);
      this.http!.listen(port, this.opts.host, () => {
        this.http!.off('error', onError);
        const addr = this.http!.address();
        const bound = typeof addr === 'object' && addr ? addr.port : port;
        const host = this.opts.host === '0.0.0.0' || this.opts.host === '::' ? 'localhost' : this.opts.host;
        resolve(new URL(`http://${host.includes(':') ? `[${host}]` : host}:${bound}/`));
      });
    });
  }

  async close(): Promise<void> {
    await this.deps.hub.close();
    await new Promise<void>((res) => {
      if (!this.http) return res();
      this.http.close(() => res());
      this.http.closeAllConnections();
    });
  }
}

function projectRoot(): string {
  // src/server/Server.ts → ../..  |  dist/server/main.js → ../..
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function resolveClientDir(): string {
  return join(projectRoot(), 'dist', 'client');
}
