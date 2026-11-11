// The single-player link in the browser (src/client/spLink.ts, main.ts): it connects only for a single-player game
// (never the tutorial) and only while online, fails silently (no server, no sockets, another protocol), retries
// 5 s doubling to 5 min, sleeps in a long-hidden tab, sends nothing but spHello and the plain status, and passes only
// announcements, notices and effects on, which the existing broadcast layer shows. It never touches the game.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CloseCode, PROTOCOL_VERSION, SP_STATUS_MS, SP_STREAM_FLUSH_MS, SP_STREAM_MAX_BYTES, SP_WATCH_BATCH } from '../src/net/protocol';
import { HIDDEN_STOP_MS, SP_RETRY_MAX_MS, SP_RETRY_MIN_MS, SpLink, packStreamEntries, spRetryMs, spShows } from '../src/client/spLink';
import type { SpLinkEnv, SpStatusFields, SpWatchSource } from '../src/client/spLink';
import type { WatchLogEntry } from '../src/net/protocol';
import { BroadcastLayer } from '../src/client/broadcast';

class FakeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }
  // test side
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(m: unknown): void {
    this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

interface World {
  env: SpLinkEnv;
  sockets: FakeSocket[];
  net: { online: boolean; hidden: boolean; throwOnOpen: boolean };
  fire: { online: () => void; visibility: () => void };
}

function world(): World {
  const sockets: FakeSocket[] = [];
  const net = { online: true, hidden: false, throwOnOpen: false };
  const fire = { online: () => {}, visibility: () => {} };
  const env: SpLinkEnv = {
    makeSocket: (url) => {
      if (net.throwOnOpen) throw new Error('blocked');
      const s = new FakeSocket(url);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    online: () => net.online,
    hidden: () => net.hidden,
    watch: (onOnline, onVis) => {
      fire.online = onOnline;
      fire.visibility = onVis;
      return () => {
        fire.online = () => {};
        fire.visibility = () => {};
      };
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
    random: () => 0,
  };
  return { env, sockets, net, fire };
}

const STATUS: SpStatusFields = { nation: 'Aurora', map: { kind: 'generated', type: 'pangaea', size: 'small' }, minutes: 4, landPct: 12.5 };
const URL = 'wss://game.example/ws';

function linked(w: World, status: () => SpStatusFields | null = () => STATUS) {
  const shown: unknown[] = [];
  const link = new SpLink(URL, status, (m) => shown.push(m), w.env);
  link.start();
  return { link, shown };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error');
  vi.spyOn(console, 'warn');
});
afterEach(() => {
  // failing quietly means nothing in the console either
  expect(console.error).not.toHaveBeenCalled();
  expect(console.warn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('single-player link: connecting', () => {
  it('retries 5 s doubling to 5 min', () => {
    const z = () => 0;
    expect([0, 1, 2, 3, 4, 5, 6, 7, 30].map((n) => spRetryMs(n, z))).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
    expect(SP_RETRY_MIN_MS).toBe(5000);
    expect(SP_RETRY_MAX_MS).toBe(300000);
    expect(spRetryMs(0, () => 0.999)).toBeLessThanOrEqual(6000);
  });

  it('says spHello, then sends the plain status at once and every 30 s, and nothing else', () => {
    const w = world();
    linked(w);
    expect(w.sockets.length).toBe(1);
    expect(w.sockets[0].url).toBe(URL);
    const s = w.sockets[0];
    s.open();
    expect(s.sent).toEqual([{ type: 'spHello', protocol: PROTOCOL_VERSION }]);
    s.recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 7 });
    expect(s.sent[1]).toEqual({ type: 'spStatus', ...STATUS });
    vi.advanceTimersByTime(SP_STATUS_MS * 3 + 10);
    expect(s.sent.length).toBe(5);
    expect(new Set(s.sent.map((m) => m.type))).toEqual(new Set(['spHello', 'spStatus']));
    // the hello carries the protocol and nothing about the player or the browser
    expect(Object.keys(s.sent[0]).sort()).toEqual(['protocol', 'type']);
  });

  it('sends no status when the game has none', () => {
    const w = world();
    linked(w, () => null);
    w.sockets[0].open();
    w.sockets[0].recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 1 });
    vi.advanceTimersByTime(SP_STATUS_MS * 2);
    expect(w.sockets[0].sent.map((m) => m.type)).toEqual(['spHello']);
  });

  it('no server address: never tries', () => {
    const w = world();
    const link = new SpLink(null, () => STATUS, () => {}, w.env);
    link.start();
    vi.advanceTimersByTime(SP_RETRY_MAX_MS * 3);
    expect(w.sockets.length).toBe(0);
  });

  it('offline: waits for the browser to be online again', () => {
    const w = world();
    w.net.online = false;
    linked(w);
    vi.advanceTimersByTime(SP_RETRY_MAX_MS);
    expect(w.sockets.length).toBe(0);
    w.net.online = true;
    w.fire.online();
    expect(w.sockets.length).toBe(1);
  });

  it('fails silently when sockets are refused or the server is down, retrying with backoff', () => {
    const w = world();
    w.net.throwOnOpen = true;
    const { link } = linked(w);
    expect(link.online).toBe(false);
    w.net.throwOnOpen = false;
    vi.advanceTimersByTime(4999);
    expect(w.sockets.length).toBe(0);
    vi.advanceTimersByTime(2);
    expect(w.sockets.length).toBe(1);
    // the server is down: each failure waits twice as long
    w.sockets[0].drop();
    vi.advanceTimersByTime(9999);
    expect(w.sockets.length).toBe(1);
    vi.advanceTimersByTime(2);
    expect(w.sockets.length).toBe(2);
    w.sockets[1].drop();
    vi.advanceTimersByTime(20001);
    expect(w.sockets.length).toBe(3);
    // a welcome resets the backoff
    w.sockets[2].open();
    w.sockets[2].recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 2 });
    expect(link.online).toBe(true);
    w.sockets[2].drop();
    expect(link.online).toBe(false);
    vi.advanceTimersByTime(5001);
    expect(w.sockets.length).toBe(4);
  });

  it('an open socket that never says welcome is dropped and retried', () => {
    const w = world();
    linked(w);
    w.sockets[0].open();
    vi.advanceTimersByTime(10_001);
    expect(w.sockets[0].closed).not.toBeNull();
    vi.advanceTimersByTime(5001);
    expect(w.sockets.length).toBe(2);
  });

  it('a server of another protocol ends the link for good, quietly', () => {
    for (const how of ['close', 'error'] as const) {
      const w = world();
      const { link } = linked(w);
      w.sockets[0].open();
      if (how === 'error') w.sockets[0].recv({ type: 'error', code: 'version', message: 'other version' });
      w.sockets[0].drop(CloseCode.Version);
      expect(link.outdated).toBe(true);
      vi.advanceTimersByTime(SP_RETRY_MAX_MS * 4);
      expect(w.sockets.length).toBe(1);
      link.stop();
      link.start();
      expect(w.sockets.length).toBe(1);
    }
  });

  it('a tab hidden for long closes the link and stops trying until it is shown', () => {
    const w = world();
    const { link } = linked(w);
    w.sockets[0].open();
    w.sockets[0].recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 3 });
    w.net.hidden = true;
    w.fire.visibility();
    vi.advanceTimersByTime(HIDDEN_STOP_MS - 1000);
    expect(link.online).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(link.online).toBe(false);
    expect(w.sockets[0].closed).toBe(1000);
    vi.advanceTimersByTime(SP_RETRY_MAX_MS * 3);
    expect(w.sockets.length).toBe(1);
    w.net.hidden = false;
    w.fire.visibility();
    expect(w.sockets.length).toBe(2);
  });

  it('stop() closes the socket and leaves no timer behind', () => {
    const w = world();
    const { link } = linked(w);
    w.sockets[0].open();
    w.sockets[0].recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 3 });
    link.stop();
    expect(w.sockets[0].closed).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SP_RETRY_MAX_MS * 2);
    expect(w.sockets.length).toBe(1);
  });
});

describe('single-player link: what it shows', () => {
  it('passes on announcements, notices and effects only, and nothing before the welcome', () => {
    const w = world();
    const { shown } = linked(w);
    const s = w.sockets[0];
    s.open();
    s.recv({ type: 'announcement', title: '', text: 'too early', style: 'info', seconds: 6 });
    s.recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 1 });
    const keep = [
      { type: 'announcement', title: 'Hi', text: 'Hello', style: 'info', seconds: 6 },
      { type: 'notice', text: 'Just you', style: 'warning', seconds: 5 },
      { type: 'spectacle', kind: 'fakeBomb', seconds: 5 },
    ];
    const drop = [
      { type: 'turn', n: 1, intents: [{ playerId: 1, action: { type: 'startNow' } }] },
      { type: 'gameStart' },
      { type: 'lobbyState' },
      { type: 'chat', entry: { text: 'x' } },
      { type: 'adminRooms', rooms: [] },
      { type: 'kicked', reason: 'x' },
      'not json',
      null,
    ];
    for (const m of [...keep, ...drop]) s.recv(m);
    expect(shown).toEqual(keep);
    expect(spShows({ type: 'turn' })).toBe(false);
  });

  it('what it passes on shows through the existing broadcast layer (text as text only)', () => {
    class El {
      className = '';
      textContent = '';
      type = '';
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      children: El[] = [];
      parent: El | null = null;
      classList = {
        contains: (c: string) => this.className.split(' ').includes(c),
        add: (...cs: string[]) => cs.forEach((c) => !this.classList.contains(c) && (this.className = `${this.className} ${c}`.trim())),
        remove: (...cs: string[]) => (this.className = this.className.split(' ').filter((x) => x && !cs.includes(x)).join(' ')),
        toggle: (c: string, on?: boolean) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
      };
      constructor(public tag: string) {}
      set innerHTML(_v: string) {
        throw new Error('innerHTML must not be used');
      }
      append(...k: El[]) {
        for (const c of k) c.parent = this;
        this.children.push(...k);
      }
      prepend(...k: El[]) {
        for (const c of k) c.parent = this;
        this.children.unshift(...k);
      }
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      }
      setAttribute() {}
      addEventListener() {}
      getContext() {
        return new Proxy({}, { get: () => () => {}, set: () => true });
      }
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }
      all(): El[] {
        return this.children.flatMap((c) => [c, ...c.all()]);
      }
    }
    vi.stubGlobal('document', { createElement: (tag: string) => new El(tag), activeElement: null });
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1 });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const root = new El('body');
    const layer = new BroadcastLayer(root as unknown as HTMLElement);
    const w = world();
    new SpLink(URL, () => STATUS, (m) => layer.handle(m), w.env).start();
    const s = w.sockets[0];
    s.open();
    s.recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 1 });
    s.recv({ type: 'announcement', title: 'News', text: '<img src=x> Peace now', style: 'celebration', seconds: 6 });
    s.recv({ type: 'notice', text: 'A word for you', style: 'info', seconds: 5 });
    s.recv({ type: 'spectacle', kind: 'fogPuff', seconds: 3 });
    const texts = root.all().map((e) => e.textContent);
    expect(texts).toContain('<img src=x> Peace now');
    expect(texts).toContain('A word for you');
    expect(layer.activePranks()).toContain('fogPuff');
    vi.advanceTimersByTime(15_000);
    expect(layer.activePranks()).toEqual([]);
    layer.destroy();
  });

  it('never touches the game: the link imports only the protocol, and main.ts links only outside the tutorial', () => {
    const src = readFileSync('src/client/spLink.ts', 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from '([^']+)'/gm)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(['../net/protocol']));
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/dispatch|applyAction|localStorage|clientId|document\.cookie/);
    const main = readFileSync('src/client/main.ts', 'utf8');
    expect(main).toMatch(/if \(!tutorial\) spLink\.start\(\);/);
    expect(main.match(/spLink\.start\(/g)?.length).toBe(1);
    // its messages go to the broadcast layer and nowhere else
    expect(main).toMatch(/new SpLink\(defaultServerUrl\(\), spStatusNow, \(msg\) => \{\n\s+const s = session;\n\s+if \(s && s\.human && !s\.mp\) broadcast\.handle\(msg\);\n\}\);/);
  });

  it('the status reads plain fields only (no sim helpers that fill caches)', () => {
    const main = readFileSync('src/client/main.ts', 'utf8');
    const body = main.slice(main.indexOf('function spStatusNow'), main.indexOf('const spLink'));
    const calls = [...body.matchAll(/\b([a-zA-Z_]\w*)\(/g)].map((m) => m[1]);
    expect(new Set(calls)).toEqual(new Set(['spStatusNow', 'slice', 'join', 'trim', 'max', 'floor', 'gameSeconds', 'min', 'round']));
  });
});

describe('owner console: single-player targets', () => {
  it('builds announcements and pranks for one single-player game or all of them', async () => {
    const { announceMessage, prankMessage } = await import('../src/client/adminOnline');
    const f = { where: 'sp' as const, here: null, sel: null, spSel: 9, title: '', text: 'Hello there', style: 'info' as const, seconds: 6 };
    expect(announceMessage(f)).toEqual({ type: 'adminAnnounce', scope: 'sp', spId: 9, title: '', text: 'Hello there', style: 'info', seconds: 6 });
    expect(announceMessage({ ...f, where: 'spAll' })).toEqual({ type: 'adminAnnounce', scope: 'sp', title: '', text: 'Hello there', style: 'info', seconds: 6 });
    expect(announceMessage({ ...f, spSel: null })).toBe('Pick a single-player game in Games first');
    const p = { where: 'sp' as const, here: null, sel: null, spSel: 9, memberId: null, kind: 'flip' as const, seconds: 4 };
    expect(prankMessage(p)).toEqual({ type: 'adminSpectacle', scope: 'sp', spId: 9, kind: 'flip', mode: 'upside', seconds: 4 });
    expect(prankMessage({ ...p, where: 'spAll', kind: 'ducks', seconds: null })).toEqual({ type: 'adminSpectacle', scope: 'sp', kind: 'ducks' });
    expect(prankMessage({ ...p, spSel: null })).toBe('Pick a single-player game in Games first');
    // the server's validator takes each of them
    const { validateClientMessage } = await import('../server/validate');
    for (const m of [announceMessage(f), announceMessage({ ...f, where: 'spAll' }), prankMessage(p), prankMessage({ ...p, where: 'spAll', kind: 'ducks', seconds: null })]) {
      expect(validateClientMessage(m).ok).toBe(true);
    }
  });
});

describe('single-player link: watch-on-demand streaming (protocol 20)', () => {
  const LOG: WatchLogEntry[] = [[0, { type: 'spawn', tile: 1 } as never], [2, { type: 'spawn', tile: 2 } as never]];
  function watched(w: World, tickVal = { t: 5 }) {
    const link = new SpLink(URL, () => STATUS, () => {}, w.env);
    const source: SpWatchSource = {
      snapshot: () => ({ settings: { seed: 1 } as never, log: LOG.slice() }),
      tick: () => tickVal.t,
    };
    link.setWatchSource(source);
    link.start();
    const s = w.sockets[0];
    s.open();
    s.recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 1 });
    return { link, s };
  }

  it('streams nothing until a watcher attaches, then sends the setup and the backlog', () => {
    const w = world();
    const { link, s } = watched(w);
    expect(link.watching).toBe(false);
    // only spHello + spStatus so far, never spSetup/spLog
    expect(new Set(s.sent.map((m) => m.type))).toEqual(new Set(['spHello', 'spStatus']));
    s.recv({ type: 'spWatch', on: true });
    expect(link.watching).toBe(true);
    const setup = s.sent.find((m) => m.type === 'spSetup');
    expect(setup).toEqual({ type: 'spSetup', settings: { seed: 1 } });
    const base = s.sent.find((m) => m.type === 'spLog');
    expect(base).toEqual({ type: 'spLog', entries: LOG, tick: 5, base: true, final: true });
  });

  it('streams live orders and idle ticks while watched, and stops when detached', () => {
    const w = world();
    const tick = { t: 5 };
    const { link, s } = watched(w, tick);
    s.recv({ type: 'spWatch', on: true });
    const before = s.sent.length;
    // a new order comes in; it flushes with the current tick on the next interval
    tick.t = 8;
    link.pushEntries([[6, { type: 'spawn', tile: 3 } as never]]);
    vi.advanceTimersByTime(SP_STREAM_FLUSH_MS + 5);
    const live = s.sent.slice(before).filter((m) => m.type === 'spLog');
    expect(live.at(-1)).toEqual({ type: 'spLog', entries: [[6, { type: 'spawn', tile: 3 }]], tick: 8 });
    // an idle tick with no orders still advances the watcher
    tick.t = 12;
    const n2 = s.sent.length;
    vi.advanceTimersByTime(SP_STREAM_FLUSH_MS + 5);
    expect(s.sent.slice(n2).filter((m) => m.type === 'spLog').at(-1)).toEqual({ type: 'spLog', entries: [], tick: 12 });
    // the owner detaches: streaming stops and new orders are not sent
    s.recv({ type: 'spWatch', on: false });
    expect(link.watching).toBe(false);
    const n3 = s.sent.length;
    tick.t = 20;
    link.pushEntries([[15, { type: 'spawn', tile: 4 } as never]]);
    vi.advanceTimersByTime(SP_STREAM_FLUSH_MS * 2);
    expect(s.sent.slice(n3).some((m) => m.type === 'spLog')).toBe(false);
  });

  it('stop() ends streaming and leaves no timer behind', () => {
    const w = world();
    const { link, s } = watched(w);
    s.recv({ type: 'spWatch', on: true });
    expect(link.watching).toBe(true);
    link.stop();
    expect(link.watching).toBe(false);
    expect(s.closed).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  // ---- fixes for the streaming caps and the backlog tick (review findings)

  const spawn = (tile: number): WatchLogEntry => [tile, { type: 'spawn', tile } as never];
  /** A fat order (an upgrade over many tiles) so a few of them pass the entry-count cap but not the byte cap. */
  const fat = (tick: number): WatchLogEntry => [tick, { type: 'upgradeBuildings', tiles: Array.from({ length: 180 }, (_, i) => i), levels: 1 } as never];
  const frameBytes = (m: Record<string, unknown>): number => JSON.stringify(m).length;

  function watchedWith(w: World, log: WatchLogEntry[], tickVal: { t: number }) {
    const link = new SpLink(URL, () => STATUS, () => {}, w.env);
    const source: SpWatchSource = { snapshot: () => ({ settings: { seed: 1 } as never, log: log.slice() }), tick: () => tickVal.t };
    link.setWatchSource(source);
    link.start();
    const s = w.sockets[0];
    s.open();
    s.recv({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 1 });
    s.recv({ type: 'spWatch', on: true });
    return { link, s };
  }
  /** Keeps flushing until the whole backlog and queue are sent (or a cap on flushes). */
  function drain(s: FakeSocket): void {
    for (let i = 0; i < 50; i++) vi.advanceTimersByTime(SP_STREAM_FLUSH_MS + 1);
    void s;
  }
  const spLogs = (s: FakeSocket) => s.sent.filter((m) => m.type === 'spLog') as { type: 'spLog'; entries: WatchLogEntry[]; tick: number; base?: boolean; final?: boolean }[];

  it('packStreamEntries keeps every frame within both server caps (count and bytes), losing nothing', () => {
    // small orders: cut by the count cap only
    const small = Array.from({ length: 130 }, (_, i) => spawn(i));
    const chunksS = packStreamEntries(small);
    expect(chunksS.every((c) => c.length <= SP_WATCH_BATCH)).toBe(true);
    expect(chunksS.flat()).toEqual(small); // nothing dropped or reordered
    expect(chunksS.length).toBe(Math.ceil(130 / SP_WATCH_BATCH));
    // fat orders: the byte cap splits them well before 48 would
    const big = Array.from({ length: 40 }, (_, i) => fat(i));
    const chunksB = packStreamEntries(big);
    expect(chunksB.length).toBeGreaterThan(1); // byte cap forced a split although 40 < SP_WATCH_BATCH
    expect(chunksB.every((c) => c.length >= 1 && frameBytes({ type: 'spLog', entries: c, tick: 0, base: true, final: true }) <= SP_STREAM_MAX_BYTES)).toBe(true);
    expect(chunksB.flat()).toEqual(big);
  });

  it('streams the backlog in capped chunks, each tagged with its own last tick and only the last marked final', () => {
    const w = world();
    const log = Array.from({ length: 120 }, (_, i) => spawn(i)); // ticks 0..119 -> 3 chunks of 48/48/24
    const { s } = watchedWith(w, log, { t: 500 });
    drain(s);
    const logs = spLogs(s);
    expect(logs.length).toBe(3);
    expect(logs.map((m) => m.entries.length)).toEqual([48, 48, 24]);
    // each non-final chunk carries its own last order's tick (so the watcher catches up order by order, not all at once)
    expect(logs[0].tick).toBe(47);
    expect(logs[1].tick).toBe(95);
    expect(logs[2].tick).toBe(500); // the final chunk carries the game's real current tick (idle tail included)
    expect(logs.map((m) => m.base)).toEqual([true, true, true]);
    expect(logs.map((m) => m.final === true)).toEqual([false, false, true]);
    expect(logs.flatMap((m) => m.entries)).toEqual(log); // the whole history reached the watcher
    expect(logs.every((m) => m.entries.length <= SP_WATCH_BATCH && frameBytes(m) <= SP_STREAM_MAX_BYTES)).toBe(true);
  });

  it('paces the backlog at STREAM_CHUNKS_PER_FLUSH frames per flush', () => {
    const w = world();
    const log = Array.from({ length: 48 * 13 }, (_, i) => spawn(i)); // 13 chunks
    const { s } = watchedWith(w, log, { t: 9999 });
    // the immediate flush sends at most 10 frames
    expect(spLogs(s).length).toBeLessThanOrEqual(10);
    expect(spLogs(s).length).toBe(10);
    drain(s);
    const logs = spLogs(s);
    expect(logs.length).toBe(13);
    expect(logs.at(-1)!.final).toBe(true);
    expect(logs.at(-1)!.tick).toBe(9999);
    expect(logs.flatMap((m) => m.entries)).toEqual(log);
  });

  it('chunks a big batch of live orders instead of one unbounded frame, and never exceeds a cap', () => {
    const w = world();
    const tick = { t: 5 };
    const { link, s } = watchedWith(w, [], tick); // empty history: one base frame, then live
    const before = spLogs(s).length;
    const live = Array.from({ length: 110 }, (_, i) => spawn(1000 + i));
    tick.t = 1200;
    link.pushEntries(live);
    drain(s);
    const liveLogs = spLogs(s).slice(before).filter((m) => !m.base);
    expect(liveLogs.length).toBeGreaterThan(1); // not one giant frame
    expect(liveLogs.every((m) => m.entries.length <= SP_WATCH_BATCH && frameBytes(m) <= SP_STREAM_MAX_BYTES)).toBe(true);
    expect(liveLogs.flatMap((m) => m.entries)).toEqual(live); // every live order delivered, none lost
  });

  it('does not lose live orders queued while the backlog is still draining', () => {
    const w = world();
    const tick = { t: 0 };
    const log = Array.from({ length: 48 * 12 }, (_, i) => spawn(i)); // 12 chunks -> more than one flush
    tick.t = 600;
    const { link, s } = watchedWith(w, log, tick);
    // the player keeps ordering while the history streams
    const live = Array.from({ length: 30 }, (_, i) => spawn(700 + i));
    tick.t = 800;
    link.pushEntries(live);
    drain(s);
    const logs = spLogs(s);
    // the backlog's final frame comes before any live frame, and all live orders arrive
    const finalIdx = logs.findIndex((m) => m.final === true);
    expect(finalIdx).toBeGreaterThanOrEqual(0);
    const backlog = logs.slice(0, finalIdx + 1).flatMap((m) => m.entries);
    const after = logs.slice(finalIdx + 1).flatMap((m) => m.entries);
    expect(backlog).toEqual(log);
    expect(after).toEqual(live);
    expect(logs.every((m) => m.entries.length <= SP_WATCH_BATCH && frameBytes(m) <= SP_STREAM_MAX_BYTES)).toBe(true);
  });
});
