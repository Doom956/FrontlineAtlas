// HTTP + WebSocket server: serves the built client, /health, and the game protocol on WS_PATH.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { ADMIN_CODE_MAX_LENGTH, WS_PATH } from '../src/net/protocol';
import { Hub } from './hub';
import { DEFAULT_OPTIONS } from './options';
import type { ServerOptions } from './options';
import { serveStatic } from './static';

/** The public client page (GitHub Pages): may call /api/admin-check from another origin. */
export const PAGES_ORIGIN = 'https://doom956.github.io';
/** Largest body /api/admin-check reads (bytes). */
export const ADMIN_CHECK_MAX_BYTES = 1024;
export const ADMIN_CHECK_PATH = '/api/admin-check';

export interface RunningServer {
  port: number;
  /** ws://host:port/ws */
  wsUrl: string;
  hub: Hub;
  http: Server;
  close(): Promise<void>;
}

/**
 * Client address: the socket's, or behind a proxy (trustProxy) the platform's own header (clientIpHeader, e.g.
 * Fly-Client-IP) or the X-Forwarded-For entry `proxyHops` places from the end. Proxies append the address they saw,
 * so the first entries are whatever the client sent: never trust them.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean, proxyHops = 1, clientIpHeader = ''): string {
  if (trustProxy) {
    if (clientIpHeader) {
      const h = req.headers[clientIpHeader.toLowerCase()];
      const v = (Array.isArray(h) ? h[h.length - 1] : h)?.trim();
      if (v) return v;
    }
    const xff = req.headers['x-forwarded-for'];
    const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const hops = Math.max(1, Math.floor(proxyHops));
    // fewer entries than proxies: the request did not pass all of them; use the first proxy's view (or the socket)
    const pick = list.length >= hops ? list[list.length - hops] : list[0];
    if (pick) return pick;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * CORS for the admin check: the Origin header (if any) must be the server's own origin or an allowed one
 * (ALLOWED_ORIGINS, else the GitHub Pages site). Returns the origin to echo, '' (no Origin: not a browser page) or
 * null (refused).
 */
export function adminCheckOrigin(req: IncomingMessage, allowed: string[]): string | null {
  const origin = req.headers.origin;
  if (!origin) return '';
  const list = allowed.length > 0 ? allowed : [PAGES_ORIGIN];
  if (list.includes(origin)) return origin;
  try {
    if (new URL(origin).host === req.headers.host) return origin;
  } catch {
    /* not a URL */
  }
  return null;
}

/** Reads a small JSON body; null when it is too large, not JSON or not an object. */
function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > ADMIN_CHECK_MAX_BYTES) {
        over = true;
        chunks.length = 0;
        return; // keep draining (cheap) so the answer can still be sent
      }
      if (!over) chunks.push(c);
    });
    req.on('error', () => resolve(null));
    req.on('end', () => {
      if (over) return resolve(null);
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function startServer(partial: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const opts: ServerOptions = { ...DEFAULT_OPTIONS, ...partial };
  const hub = new Hub(opts);
  const started = Date.now();

  const handleAdminCheck = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = adminCheckOrigin(req, opts.allowedOrigins);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (status: number, ok: boolean): void => {
      res.writeHead(status, headers).end(JSON.stringify({ ok }));
    };
    if (origin === null) return reply(403, false);
    if (req.method === 'OPTIONS') {
      res
        .writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' })
        .end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...headers, Allow: 'POST, OPTIONS' }).end(JSON.stringify({ ok: false }));
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > ADMIN_CHECK_MAX_BYTES) {
      res.writeHead(413, { ...headers, Connection: 'close' }).end(JSON.stringify({ ok: false }));
      return;
    }
    const ip = clientIp(req, opts.trustProxy, opts.proxyHops, opts.clientIpHeader);
    void readSmallJson(req).then((body) => {
      const code = body?.code;
      if (typeof code !== 'string' || code.length === 0 || code.length > ADMIN_CODE_MAX_LENGTH) return reply(body ? 200 : 400, false);
      reply(200, hub.admin.check(ip, code));
    });
  };

  const http = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === ADMIN_CHECK_PATH || url.startsWith(`${ADMIN_CHECK_PATH}?`)) {
      handleAdminCheck(req, res);
      return;
    }
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
      res.end(opts.staticDir ? 'Not found' : 'Frontline Atlas game server. The client is not served here (run npm run build).');
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
    const ip = clientIp(req, opts.trustProxy, opts.proxyHops, opts.clientIpHeader);
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
