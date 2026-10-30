// Browser side of the multiplayer connection: one WebSocket to the relay server (src/net/protocol.ts), `hello` with a
// persistent clientId, automatic reconnects with backoff (the server puts us back into our lobby or game), keepalive
// pings with a latency estimate, and the server clock offset for countdowns. No game logic here: the lobby screen
// and the lockstep runner (src/client/mpgame.ts) listen to the messages.
import * as config from '../sim/config';
import { CloseCode, makeClientId, PING_INTERVAL_MS, PROTOCOL_VERSION, resolveServerUrl, CLIENT_ID_PATTERN } from './protocol';
import type { ClientMessage, ResumeInfo, RGB, ServerMessage } from './protocol';

export type NetStatus =
  /** not started yet */
  | 'idle'
  | 'connecting'
  /** socket open and `welcome` received */
  | 'online'
  /** lost the connection; trying again after a pause */
  | 'reconnecting'
  /** close() was called */
  | 'closed'
  /** the server runs another protocol version: the page must be reloaded */
  | 'outdated'
  /** the same clientId connected from another tab */
  | 'replaced'
  /** no server address (file:// page without ?server=) */
  | 'noServer';

const CLIENT_ID_KEY = 'borderfall.clientId';
/** Reconnect pauses (ms), then the last one forever, each with up to 30% random jitter. */
const BACKOFF_MS = [300, 1000, 2000, 4000, 8000, 12000];
/** No `welcome` this long after opening: drop the socket and try again. */
const WELCOME_TIMEOUT_MS = 8000;

let memoryClientId: string | null = null;

/** The persistent clientId (localStorage; a fresh one per tab when storage is blocked). It is your seat. */
export function loadClientId(): string {
  try {
    const v = localStorage.getItem(CLIENT_ID_KEY);
    if (v && CLIENT_ID_PATTERN.test(v)) return v;
    const id = makeClientId();
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    memoryClientId ??= makeClientId();
    return memoryClientId;
  }
}

/**
 * Build id sent in `hello`: VITE_BUILD_ID when set at build time, else a fingerprint of the protocol version and all
 * balance data (src/sim/config.ts), so clients with different rules never share a lobby. Code changes that keep
 * the balance data equal are not caught: deploy every client from one build (docs/MULTIPLAYER.md).
 */
export function clientBuildId(): string {
  const env = (import.meta as ImportMeta).env;
  if (env?.VITE_BUILD_ID) return String(env.VITE_BUILD_ID).slice(0, 64);
  let h = 0x811c9dc5;
  const text = `p${PROTOCOL_VERSION}:` + JSON.stringify(config, (_k, v) => (typeof v === 'function' ? undefined : v));
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `cfg-${(h >>> 0).toString(16)}`;
}

/** The server's WebSocket URL for this page (?server=, then VITE_SERVER_URL, then same origin /ws). */
export function defaultServerUrl(): string | null {
  if (typeof location === 'undefined') return null;
  const env = (import.meta as ImportMeta).env;
  return resolveServerUrl(location, env?.VITE_SERVER_URL ?? null);
}

export interface NetIdentity {
  name: string;
  color: RGB;
}

type Listener = (msg: ServerMessage) => void;
type StatusListener = (status: NetStatus) => void;

/** One connection to the multiplayer server, kept alive until close(). */
export class NetClient {
  readonly url: string | null;
  readonly clientId: string;
  readonly build: string;
  status: NetStatus = 'idle';
  /** round trip of the last ping (ms), null before the first pong */
  latencyMs: number | null = null;
  /** serverTime ~ Date.now() + clockOffset */
  clockOffset = 0;
  /** reconnect attempts since the last welcome */
  attempts = 0;

  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private resume: (() => ResumeInfo | null) | null = null;

  constructor(
    private identity: NetIdentity,
    url: string | null = defaultServerUrl(),
  ) {
    this.url = url;
    this.clientId = loadClientId();
    this.build = clientBuildId();
  }

  get online(): boolean {
    return this.status === 'online';
  }

  /** Server time now (ms), from the clock offset measured with `welcome` and every pong. */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Name and colour for the next `hello`; when connected, reconnects so the server sees them. */
  setIdentity(id: NetIdentity, reconnect = false): void {
    const changed = id.name !== this.identity.name || id.color.join() !== this.identity.color.join();
    this.identity = { name: id.name, color: [...id.color] as RGB };
    if (changed && reconnect && this.ws) this.reconnectNow();
  }

  /** What to put in `hello.resume` on every (re)connect: the online game this client holds and how far it got. */
  setResume(fn: (() => ResumeInfo | null) | null): void {
    this.resume = fn;
  }

  connect(): void {
    this.stopped = false;
    if (this.ws || this.retryTimer) return;
    if (!this.url) {
      this.setStatus('noServer');
      return;
    }
    this.open();
  }

  /** Drops the socket and opens a new one at once (the server resumes our lobby or game). */
  reconnectNow(): void {
    this.stopped = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }
    this.attempts = 0;
    this.open();
  }

  /** Test hook: closes the socket like a network failure; the client reconnects with backoff. */
  dropForTest(): void {
    try {
      this.ws?.close(4900, 'test drop');
    } catch {
      /* closed */
    }
  }

  /** Closes for good (no reconnect). */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }
    this.setStatus('closed');
  }

  /** Sends a message when online; false when it could not be sent. */
  send(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || (this.status !== 'online' && msg.type !== 'hello')) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------- internals

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) {
      try {
        fn(s);
      } catch (err) {
        console.error(err);
      }
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.pingTimer = this.retryTimer = this.welcomeTimer = null;
  }

  private open(): void {
    if (!this.url) return;
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.warn('WebSocket failed', err);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const hello: ClientMessage = {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        name: this.identity.name,
        color: this.identity.color,
        clientId: this.clientId,
        build: this.build,
      };
      const resume = this.resume?.() ?? null;
      if (resume) hello.resume = resume;
      ws.send(JSON.stringify(hello));
      this.welcomeTimer = setTimeout(() => {
        if (this.ws === ws && this.status !== 'online') ws.close(4900);
      }, WELCOME_TIMEOUT_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      this.latencyMs = null;
      if (this.stopped) return;
      if (ev.code === CloseCode.Version) return this.setStatus('outdated');
      if (ev.code === CloseCode.Replaced) return this.setStatus('replaced');
      if (ev.code === CloseCode.BadClient) console.warn('Server closed the connection:', ev.reason || ev.code);
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const base = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)];
    this.attempts++;
    this.setStatus('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && !this.ws) this.open();
    }, base * (1 + Math.random() * 0.3));
  }

  private handle(msg: ServerMessage): void {
    if (msg.type === 'welcome') {
      if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
      this.clockOffset = msg.serverTime - Date.now();
      this.attempts = 0;
      this.setStatus('online');
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
      this.ping();
    } else if (msg.type === 'pong') {
      if (typeof msg.t === 'number') {
        const rtt = Math.max(0, performance.now() - msg.t);
        this.latencyMs = this.latencyMs === null ? rtt : this.latencyMs * 0.6 + rtt * 0.4;
        this.clockOffset = msg.serverTime + rtt / 2 - Date.now();
      }
      return;
    } else if (msg.type === 'error' && msg.code === 'version') {
      console.warn(msg.message);
    }
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch (err) {
        console.error('Message handler failed', msg.type, err);
      }
    }
  }

  private ping(): void {
    this.send({ type: 'ping', t: performance.now() });
  }
}
