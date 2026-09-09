import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { ServerMessage } from '../shared/protocol.js';
import type { RequestGuard } from './guard.js';

/** Clients send nothing; anything larger than a ping is not a client. */
const MAX_PAYLOAD_BYTES = 4096;

/** Broadcast hub on `/ws`: server → client only. */
export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  private readonly clientListeners = new Set<(count: number) => void>();

  attach(server: HttpServer, guard: RequestGuard = () => true): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') return;
      if (!guard({ host: req.headers.host, origin: req.headers.origin })) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        // A malformed frame emits 'error'; unhandled, it would take the process down.
        ws.on('error', () => ws.terminate());
        ws.once('close', () => this.notifyClientListeners());
        this.notifyClientListeners();
      });
    });
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) if (client.readyState === client.OPEN) client.send(data);
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  /** Reports each client-count change until the returned unsubscribe function runs. */
  onClientsChanged(listener: (count: number) => void): () => void {
    this.clientListeners.add(listener);
    return () => this.clientListeners.delete(listener);
  }

  private notifyClientListeners(): void {
    for (const listener of this.clientListeners) listener(this.clientCount);
  }

  close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    return new Promise((res) => this.wss.close(() => res()));
  }
}
