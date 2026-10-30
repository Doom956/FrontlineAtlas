// HTTP + WebSocket server: serves the built client, /health, and the game protocol on WS_PATH.

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { WS_PATH } from '../src/net/protocol';
import { Hub } from './hub';
import { DEFAULT_OPTIONS } from './options';
import type { ServerOptions } from './options';
import { serveStatic } from './static';

export interface RunningServer {
  port: number;
  /** ws://host:port/ws */
  wsUrl: string;
  hub: Hub;
  http: Server;
  close(): Promise<void>;
}

/** Client address: the socket's, or (behind a proxy) Fly-Client-IP / the first X-Forwarded-For entry. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fly = req.headers['fly-client-ip'];
    if (typeof fly === 'string' && fly) return fly.trim();
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startServer(partial: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const opts: ServerOptions = { ...DEFAULT_OPTIONS, ...partial };
  const hub = new Hub(opts);
  const started = Date.now();

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (url === '/health' || url.startsWith('/health?')) {
      const body = JSON.stringify({ ok: true, uptimeSeconds: Math.round((Date.now() - started) / 1000), ...hub.stats() });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
      return;
    }
    const notFound = (): void => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(opts.staticDir ? 'Not found' : 'Borderfall game server. The client is not served here (run npm run build).');
    };
    if (!opts.staticDir) {
      notFound();
      return;
    }
    serveStatic(opts.staticDir, req, res)
      .then((found) => {
        if (!found) notFound();
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  http.headersTimeout = 20_000;
  http.requestTimeout = 30_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxMessageBytes, perMessageDeflate: false });

  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let path = '';
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      path = '';
    }
    if (path !== WS_PATH) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    const origin = req.headers.origin;
    if (opts.allowedOrigins.length > 0 && (!origin || !opts.allowedOrigins.includes(origin))) {
      refuse(socket, 403, 'Forbidden');
      return;
    }
    const ip = clientIp(req, opts.trustProxy);
    if (!hub.canAccept(ip)) {
      refuse(socket, 429, 'Too Many Requests');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.addConnection(ws, ip);
    });
  });

  await new Promise<void>((res, rej) => {
    http.once('error', rej);
    http.listen(opts.port, opts.host, () => {
      http.off('error', rej);
      res();
    });
  });
  const port = (http.address() as AddressInfo).port;
  const host = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;

  return {
    port,
    wsUrl: `ws://${host}:${port}${WS_PATH}`,
    hub,
    http,
    close: () =>
      new Promise<void>((res) => {
        hub.stop();
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.closeAllConnections?.();
        http.close(() => res());
      }),
  };
}
