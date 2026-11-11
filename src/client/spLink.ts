// Single-player link (protocol 19: spHello / spStatus): while a single-player game is on screen and the page is
// online, it keeps one small socket to the game server so the game can receive announcements, messages and screen
// effects (broadcast.ts shows them). It is optional and quiet: no server, no network, a server of another version,
// a refused socket or a page that can't open sockets at all just means no link, with nothing shown and the game
// playing exactly the same. The tutorial never opens it (main.ts).
//
// What goes out: `spHello {protocol}` and, about every SP_STATUS_MS, `spStatus {nation, map, minutes, landPct}` read
// from plain fields of the game (the status callback, never a sim helper that fills caches). Nothing else is sent:
// no clientId, no name typed for online games, no actions. What comes in: only `announcement`, `notice` and
// `spectacle` are passed on (onShow); every other message is ignored. Nothing here can change the game.
//
// Reconnects: 5 s, doubling to 5 min (with a little jitter). A tab hidden for HIDDEN_STOP_MS closes the link and stops
// trying until it is shown again. A server with another protocol ends the link for the rest of the page's life.
import { CloseCode, PROTOCOL_VERSION, SP_STATUS_MS, SP_STREAM_FLUSH_MS, SP_STREAM_MAX_BYTES, SP_WATCH_BATCH } from '../net/protocol';
import type { ClientMessage, ServerMessage, SpLogMsg, SpSetupMsg, SpStatusMsg, WatchLogEntry } from '../net/protocol';

/** spLog frames sent per flush while streaming to a watcher (backlog and live both; paced under the message budget). */
const STREAM_CHUNKS_PER_FLUSH = 10;
/**
 * Overhead (bytes) of an spLog frame around its entries array: the type, the tick and the base/final flags, e.g.
 * `{"type":"spLog","entries":[],"tick":2147483647,"base":true,"final":true}` is 72 bytes. A margin keeps each packed
 * frame under SP_STREAM_MAX_BYTES, the cap the server rejects a longer frame at (hub.ts), so a real send never trips it.
 */
const STREAM_FRAME_OVERHEAD = 96;

/** Bytes one recorded order adds to a frame's entries array (its JSON plus the separating comma). */
function entryStreamBytes(e: WatchLogEntry): number {
  try {
    return JSON.stringify(e).length + 1;
  } catch {
    return SP_STREAM_MAX_BYTES; // unserialisable (never happens for a validated action): forces its own frame, then drops out
  }
}

/**
 * Splits recorded orders into frames each within both of the server's caps: SP_WATCH_BATCH entries and
 * SP_STREAM_MAX_BYTES bytes. One frame always carries at least one order so the stream makes progress (a single
 * recorded order is far below the byte cap). Used for the backlog and, the same way, for live orders.
 */
export function packStreamEntries(entries: readonly WatchLogEntry[]): WatchLogEntry[][] {
  const out: WatchLogEntry[][] = [];
  let i = 0;
  while (i < entries.length) {
    let bytes = STREAM_FRAME_OVERHEAD;
    let count = 0;
    while (i + count < entries.length && count < SP_WATCH_BATCH) {
      const add = entryStreamBytes(entries[i + count]);
      if (count > 0 && bytes + add > SP_STREAM_MAX_BYTES) break;
      bytes += add;
      count++;
    }
    out.push(entries.slice(i, i + count));
    i += count;
  }
  return out;
}

/** First reconnect pause (ms); each failure doubles it up to SP_RETRY_MAX_MS. */
export const SP_RETRY_MIN_MS = 5_000;
export const SP_RETRY_MAX_MS = 5 * 60_000;
/** A tab hidden this long closes the link and stops retrying until it is visible again (ms). */
export const HIDDEN_STOP_MS = 10 * 60_000;
/** No spWelcome this long after the socket opened: drop it and retry later (ms). */
const WELCOME_TIMEOUT_MS = 10_000;

/** What the status reads from the game on screen (plain fields only); null = nothing to report now. */
export type SpStatusFields = Omit<SpStatusMsg, 'type'>;

/**
 * What a watched game lets the link stream (watch-on-demand, protocol 20). The link reads this only once a watcher is
 * attached; the game pushes new orders through pushEntries(). It never touches or reads the sim: snapshot gives plain
 * recorded data (settings + the order log) and tick a plain number. One-way: the link only sends; it gets nothing back.
 */
export interface SpWatchSource {
  /** the game's full setup and whole order log now (plain recorded data), or null when there is nothing to stream */
  snapshot(): { settings: SpSetupMsg['settings']; log: WatchLogEntry[] } | null;
  /** the game's current state.tick (a plain field read) */
  tick(): number;
}

/** The bits of the page the link uses (real ones by default; tests pass their own). */
export interface SpLinkEnv {
  makeSocket(url: string): WebSocket;
  /** false when the browser knows it is offline */
  online(): boolean;
  hidden(): boolean;
  /** listens for 'online' and visibility changes; returns the unsubscribe */
  watch(onOnline: () => void, onVisibility: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(t: unknown): void;
  random(): number;
}

function browserEnv(): SpLinkEnv {
  return {
    makeSocket: (url) => new WebSocket(url),
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    watch: (onOnline, onVisibility) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
    random: () => Math.random(),
  };
}

/** The pause before reconnect attempt `n` (0-based): 5 s doubling to 5 min, plus up to 20% jitter. */
export function spRetryMs(n: number, random = Math.random): number {
  const base = Math.min(SP_RETRY_MAX_MS, SP_RETRY_MIN_MS * 2 ** Math.min(Math.max(0, n), 16));
  return Math.round(base * (1 + random() * 0.2));
}

/** Which server messages a single-player game shows; everything else from the link is ignored. */
export function spShows(msg: unknown): msg is Extract<ServerMessage, { type: 'announcement' | 'notice' | 'spectacle' }> {
  if (!msg || typeof msg !== 'object') return false;
  const t = (msg as { type?: unknown }).type;
  return t === 'announcement' || t === 'notice' || t === 'spectacle';
}

export class SpLink {
  /** the server runs another protocol: no link for the rest of this page's life */
  outdated = false;
  private ws: WebSocket | null = null;
  private wanted = false;
  /** stopped by a long-hidden tab (starts again when it is shown) */
  private sleeping = false;
  private attempts = 0;
  private welcomed = false;
  private retryTimer: unknown = null;
  private statusTimer: unknown = null;
  private welcomeTimer: unknown = null;
  private hiddenTimer: unknown = null;
  private unwatch: (() => void) | null = null;
  private readonly env: SpLinkEnv;

  // ---- watch-on-demand (protocol 20): streaming the game's log to one watcher the owner attached
  /** the owner is watching this game: the link streams its setup and log (one-way) */
  watching = false;
  private watchSource: SpWatchSource | null = null;
  private streamTimer: unknown = null;
  /** backlog chunks still to send (the game's history at the moment watching started), paced */
  private backlog: WatchLogEntry[][] = [];
  private backlogTick = 0;
  /** new orders made since watching started, waiting to be flushed */
  private liveQueue: WatchLogEntry[] = [];
  /** the game tick in the last stream frame sent (so idle ticks still advance the watcher) */
  private lastStreamTick = -1;

  constructor(
    private readonly url: string | null,
    /** the game's status now (plain fields); null = none (then nothing is sent) */
    private readonly status: () => SpStatusFields | null,
    /** an announcement, notice or effect to show */
    private readonly onShow: (msg: Extract<ServerMessage, { type: 'announcement' | 'notice' | 'spectacle' }>) => void,
    env?: SpLinkEnv,
  ) {
    this.env = env ?? browserEnv();
  }

  /** Linked now (the server said spWelcome and the socket is open). */
  get online(): boolean {
    return this.welcomed && !!this.ws;
  }

  /** A single-player game is on screen: link when possible. Safe to call again. */
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.sleeping = false;
    this.attempts = 0;
    try {
      this.unwatch = this.env.watch(
        () => this.onOnline(),
        () => this.onVisibility(),
      );
    } catch {
      this.unwatch = null;
    }
    if (this.env.hidden()) this.armHidden();
    this.open();
  }

  /** The game left the screen: close the link and stop trying. */
  stop(): void {
    this.wanted = false;
    this.sleeping = false;
    this.unwatch?.();
    this.unwatch = null;
    this.clear(this.hiddenTimer, 't');
    this.hiddenTimer = null;
    this.drop(); // also stops any streaming; the watch source (a stable read of the game) is kept
  }

  /**
   * The game on screen lets its log be watched (set once by main.ts). The link reads it only after the owner attaches
   * a watcher; it never streams on its own. Clearing it (null) ends any streaming.
   */
  setWatchSource(src: SpWatchSource | null): void {
    this.watchSource = src;
    if (!src) this.stopStreaming();
  }

  /** The game made new orders (main.ts, on every recorded action): stream them if a watcher is attached. */
  pushEntries(entries: WatchLogEntry[]): void {
    if (!this.watching || !entries.length) return;
    for (const e of entries) this.liveQueue.push(e);
  }

  // ---------------------------------------------------------------------------------------------- internals

  private clear(t: unknown, kind: 't' | 'i'): void {
    if (t === null) return;
    try {
      if (kind === 'i') this.env.clearInterval(t);
      else this.env.clearTimeout(t);
    } catch {
      /* gone */
    }
  }

  /** Closes the socket and every timer except the hidden-tab one. */
  private drop(): void {
    this.stopStreaming();
    this.clear(this.retryTimer, 't');
    this.clear(this.statusTimer, 'i');
    this.clear(this.welcomeTimer, 't');
    this.retryTimer = this.statusTimer = this.welcomeTimer = null;
    this.welcomed = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }
  }

  private canTry(): boolean {
    return this.wanted && !this.sleeping && !this.outdated && !!this.url;
  }

  private open(): void {
    if (!this.canTry() || this.ws || this.retryTimer !== null) return;
    if (!this.env.online()) return; // the 'online' event opens it
    let ws: WebSocket;
    try {
      ws = this.env.makeSocket(this.url!);
    } catch {
      // the page may not open sockets at all (a sandboxed copy): try again later, quietly
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendRaw({ type: 'spHello', protocol: PROTOCOL_VERSION });
      this.welcomeTimer = this.env.setTimeout(() => {
        this.welcomeTimer = null;
        if (this.ws === ws && !this.welcomed) this.lost();
      }, WELCOME_TIMEOUT_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string' || ev.data.length > 64 * 1024) return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      if (ev.code === CloseCode.Version) this.outdated = true;
      this.lost();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: unknown; code?: unknown };
    if (m.type === 'spWelcome') {
      this.clear(this.welcomeTimer, 't');
      this.welcomeTimer = null;
      this.welcomed = true;
      this.attempts = 0;
      this.sendStatus();
      this.clear(this.statusTimer, 'i');
      this.statusTimer = this.env.setInterval(() => this.sendStatus(), SP_STATUS_MS);
      return;
    }
    if (m.type === 'error' && m.code === 'version') {
      this.outdated = true;
      return;
    }
    if (m.type === 'spWatch') {
      // the owner attached (or detached) a watcher: start or stop streaming the log (watch-on-demand)
      if (this.welcomed) {
        if ((m as { on?: unknown }).on === true) this.startStreaming();
        else this.stopStreaming();
      }
      return;
    }
    if (!this.welcomed || !spShows(msg)) return;
    try {
      this.onShow(msg);
    } catch {
      /* decoration only */
    }
  }

  private sendStatus(): void {
    if (!this.online) return;
    let st: SpStatusFields | null = null;
    try {
      st = this.status();
    } catch {
      st = null;
    }
    if (st) this.sendRaw({ type: 'spStatus', ...st });
  }

  // ---------------------------------------------------------------------------------------------- watch streaming

  /** The owner attached a watcher: send the setup and queue the whole history, then stream live orders. */
  private startStreaming(): void {
    this.stopStreaming();
    const src = this.watchSource;
    const snap = src ? src.snapshot() : null;
    if (!src || !snap) {
      // nothing to stream (should not happen: the game sets a source before it can be watched)
      return;
    }
    this.watching = true;
    this.sendRaw({ type: 'spSetup', settings: snap.settings });
    this.backlogTick = src.tick();
    // chunk by both caps (count and bytes), so a backlog of fat group orders never builds a frame the server rejects
    this.backlog = packStreamEntries(snap.log);
    // an empty history still needs one base frame so the watcher knows it is caught up
    if (!this.backlog.length) this.backlog.push([]);
    this.lastStreamTick = -1;
    this.flushStream();
    this.streamTimer = this.env.setInterval(() => this.flushStream(), SP_STREAM_FLUSH_MS);
  }

  /** Stops streaming and forgets the queue (the owner detached, or the link dropped). */
  private stopStreaming(): void {
    this.watching = false;
    this.clear(this.streamTimer, 'i');
    this.streamTimer = null;
    this.backlog = [];
    this.liveQueue = [];
    this.backlogTick = 0;
    this.lastStreamTick = -1;
  }

  /**
   * Sends at most STREAM_CHUNKS_PER_FLUSH frames per flush, backlog first and then live orders, each within the
   * server's caps. Every frame is tagged with a tick the watcher is safe to advance its sim to: a backlog or partial
   * live chunk with the tick of its own last order (more orders at a later tick are still to come), the frame that
   * drains the live queue (and an idle frame with no orders) with the game's current tick, so the watcher follows live
   * across ticks that had no orders. The watcher's pump() stops before the target tick, so an order recorded at the
   * current tick but sent in the next flush is still applied in time.
   */
  private flushStream(): void {
    if (!this.watching || !this.online) return;
    const src = this.watchSource;
    if (!src) return this.stopStreaming();
    let budget = STREAM_CHUNKS_PER_FLUSH;
    // 1) the history, paced; each chunk carries its own last tick so the sim catches up order by order, not all at once
    while (budget > 0 && this.backlog.length) {
      const chunk = this.backlog.shift()!;
      const last = this.backlog.length === 0;
      const tick = last ? this.backlogTick : chunk.length ? chunk[chunk.length - 1][0] : this.backlogTick;
      const frame: SpLogMsg = { type: 'spLog', entries: chunk, tick, base: true };
      if (last) frame.final = true;
      this.sendRaw(frame);
      this.lastStreamTick = tick;
      budget--;
    }
    if (this.backlog.length) return; // still sending the history; live orders wait their turn
    // 2) live orders, chunked and size-bounded exactly like the backlog (never one unbounded frame)
    while (budget > 0 && this.liveQueue.length) {
      const chunk = this.takeLiveChunk();
      const drained = this.liveQueue.length === 0;
      const tick = drained ? Math.max(src.tick(), chunk[chunk.length - 1][0]) : chunk[chunk.length - 1][0];
      this.sendRaw({ type: 'spLog', entries: chunk, tick });
      this.lastStreamTick = tick;
      budget--;
    }
    // 3) no orders left to send but the game ticked on: a bare tick keeps the watcher advancing
    if (!this.liveQueue.length) {
      const tick = src.tick();
      if (tick > this.lastStreamTick) {
        this.sendRaw({ type: 'spLog', entries: [], tick });
        this.lastStreamTick = tick;
      }
    }
  }

  /** Removes and returns the next live frame's worth of orders, within both of the server's caps (count and bytes). */
  private takeLiveChunk(): WatchLogEntry[] {
    const out: WatchLogEntry[] = [];
    let bytes = STREAM_FRAME_OVERHEAD;
    while (this.liveQueue.length && out.length < SP_WATCH_BATCH) {
      const add = entryStreamBytes(this.liveQueue[0]);
      if (out.length > 0 && bytes + add > SP_STREAM_MAX_BYTES) break;
      bytes += add;
      out.push(this.liveQueue.shift()!);
    }
    return out;
  }

  private sendRaw(msg: ClientMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closing */
    }
  }

  /** The socket closed or never answered: forget it and try again later (unless that can't help). */
  private lost(): void {
    this.drop();
    this.retry();
  }

  private retry(): void {
    if (!this.canTry() || this.retryTimer !== null) return;
    const ms = spRetryMs(this.attempts++, () => this.env.random());
    this.retryTimer = this.env.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, ms);
  }

  private onOnline(): void {
    if (!this.canTry() || this.ws) return;
    this.clear(this.retryTimer, 't');
    this.retryTimer = null;
    this.open();
  }

  private armHidden(): void {
    if (this.hiddenTimer !== null) return;
    this.hiddenTimer = this.env.setTimeout(() => {
      this.hiddenTimer = null;
      if (this.wanted && this.env.hidden()) {
        this.sleeping = true;
        this.drop();
      }
    }, HIDDEN_STOP_MS);
  }

  private onVisibility(): void {
    if (!this.wanted) return;
    if (this.env.hidden()) {
      this.armHidden();
      return;
    }
    this.clear(this.hiddenTimer, 't');
    this.hiddenTimer = null;
    if (this.sleeping) {
      this.sleeping = false;
      this.attempts = 0;
      this.open();
    }
  }
}
