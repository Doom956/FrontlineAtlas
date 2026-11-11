// Single-player links on the server (protocol 19: spHello / spStatus, server/hub.ts, validate.ts): a link is accepted
// and validated, counts against the per-address limits, may send nothing but spStatus and ping, shows in the owner's
// list, gets the owner's announcements, messages and screen effects (one game, all single-player games, every
// screen), never from anyone else, and is forgotten when it closes. The code here is made up for the tests.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CloseCode, PROTOCOL_VERSION, SP_MESSAGE_MAX_BYTES, makeClientId } from '../src/net/protocol';
import type { ServerMessage } from '../src/net/protocol';
import { startServer } from '../server/server';
import type { RunningServer } from '../server/server';
import { validateClientMessage } from '../server/validate';

const TEST_CODE = 'made-up-sp-test-code';
type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Client {
  readonly inbox: ServerMessage[] = [];
  closeCode: number | null = null;
  clientId = makeClientId();
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString()) as ServerMessage));
    ws.on('close', (code) => (this.closeCode = code));
  }
  static connect(url: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new Client(ws);
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
    });
  }
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  async take<T extends ServerMessage['type']>(type: T, pred: (m: Msg<T>) => boolean = () => true, timeout = 3000): Promise<Msg<T>> {
    const end = Date.now() + timeout;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m as Msg<T>));
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Msg<T>;
      if (Date.now() > end) throw new Error(`timeout waiting for ${type}; inbox: ${JSON.stringify(this.inbox.map((m) => m.type))}`);
      await sleep(5);
    }
  }
  has(type: ServerMessage['type']): boolean {
    return this.inbox.some((m) => m.type === type);
  }
  async closed(timeout = 3000): Promise<number> {
    const end = Date.now() + timeout;
    while (this.closeCode === null) {
      if (Date.now() > end) throw new Error('socket still open');
      await sleep(5);
    }
    return this.closeCode;
  }
  close(): void {
    this.ws.close();
  }
}

const base = { port: 0, host: '127.0.0.1', publicLobbies: false, turnMs: 30, firstTurnDelayMs: 0, sweepMs: 20, createLobbyCooldownMs: 0, maxRoomsPerIp: 50, log: () => {} };
const status = (nation = 'Aurora', minutes = 3, landPct = 12.34) => ({ type: 'spStatus', nation, map: { kind: 'generated', type: 'pangaea', size: 'small' }, minutes, landPct });

let srv: RunningServer | null = null;
const open: Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await srv?.close();
  srv = null;
});

async function server(extra: Record<string, unknown> = {}): Promise<RunningServer> {
  srv = await startServer({ ...base, adminCode: TEST_CODE, ...extra });
  return srv;
}
async function client(s: RunningServer): Promise<Client> {
  const c = await Client.connect(s.wsUrl);
  open.push(c);
  return c;
}
/** A single-player link: spHello, spWelcome, then one status. */
async function spGame(s: RunningServer, nation = 'Aurora'): Promise<{ c: Client; spId: number }> {
  const c = await client(s);
  c.send({ type: 'spHello', protocol: PROTOCOL_VERSION });
  const w = await c.take('spWelcome');
  c.send(status(nation));
  return { c, spId: w.spId };
}
async function player(s: RunningServer, name: string): Promise<Client> {
  const c = await client(s);
  c.send({ type: 'hello', protocol: PROTOCOL_VERSION, name, color: [10, 20, 30], clientId: c.clientId, build: 'test' });
  await c.take('welcome');
  return c;
}
async function owner(s: RunningServer): Promise<Client> {
  const c = await player(s, 'Boss');
  c.send({ type: 'adminAuth', code: TEST_CODE });
  expect((await c.take('adminAuth')).ok).toBe(true);
  return c;
}
async function list(o: Client): Promise<Msg<'adminRooms'>> {
  o.send({ type: 'adminRooms' });
  return o.take('adminRooms');
}

describe('single-player link: messages', () => {
  it('protocol 19 has the link', () => {
    expect(PROTOCOL_VERSION).toBe(19);
  });

  it('validates spHello and spStatus and rebuilds them without extra fields', () => {
    expect(validateClientMessage({ type: 'spHello', protocol: 19, clientId: 'x' })).toEqual({ ok: true, value: { type: 'spHello', protocol: 19 } });
    expect(validateClientMessage({ ...status(' Big   Land ', 12, 33.333), extra: 1 })).toEqual({
      ok: true,
      value: { type: 'spStatus', nation: 'Big Land', map: { kind: 'generated', type: 'pangaea', size: 'small' }, minutes: 12, landPct: 33.3 },
    });
    expect(validateClientMessage({ ...status(), map: { kind: 'world', id: 'europe' } }).ok).toBe(true);
    for (const bad of [
      { type: 'spHello' },
      { type: 'spHello', protocol: 'x' },
      { ...status(''), type: 'spStatus' },
      { ...status('x'.repeat(40)) },
      { ...status(), map: { kind: 'world', id: 'nowhere' } },
      { ...status(), map: 'Europe' },
      { ...status(), minutes: -1 },
      { ...status(), minutes: 1.5 },
      { ...status(), minutes: 1e9 },
      { ...status(), landPct: 101 },
      { ...status(), landPct: Number.NaN },
      { ...status(), landPct: '5' },
    ]) {
      expect(validateClientMessage(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('validates the owner messages for single-player games', () => {
    expect(validateClientMessage({ type: 'adminAnnounce', scope: 'sp', title: '', text: 'Hi', style: 'info', seconds: 6 }).ok).toBe(true);
    expect(validateClientMessage({ type: 'adminAnnounce', scope: 'sp', spId: 4, title: '', text: 'Hi', style: 'info', seconds: 6 })).toMatchObject({ ok: true, value: { spId: 4 } });
    expect(validateClientMessage({ type: 'adminSpectacle', scope: 'sp', spId: 4, kind: 'flip', mode: 'mirror', seconds: 4 }).ok).toBe(true);
    expect(validateClientMessage({ type: 'adminNotice', spId: 4, text: 'Hello', style: 'warning' })).toEqual({ ok: true, value: { type: 'adminNotice', spId: 4, text: 'Hello', style: 'warning' } });
    for (const bad of [
      { type: 'adminAnnounce', scope: 'room', spId: 4, title: '', text: 'Hi', style: 'info', seconds: 6 },
      { type: 'adminAnnounce', scope: 'sp', code: 'ABCDEF', title: '', text: 'Hi', style: 'info', seconds: 6 },
      { type: 'adminAnnounce', scope: 'sp', spId: 0, title: '', text: 'Hi', style: 'info', seconds: 6 },
      { type: 'adminSpectacle', scope: 'sp', kind: 'ping', tile: 4 },
      { type: 'adminSpectacle', scope: 'sp', kind: 'confetti', tile: 4 },
      { type: 'adminSpectacle', scope: 'sp', kind: 'flip', memberId: 1 },
      { type: 'adminSpectacle', scope: 'all', spId: 3, kind: 'shake' },
      { type: 'adminNotice', spId: 4, memberId: 1, text: 'Hello', style: 'info' },
      { type: 'adminNotice', spId: 4, code: 'ABCDEF', text: 'Hello', style: 'info' },
      { type: 'adminNotice', spId: 1.5, text: 'Hello', style: 'info' },
    ]) {
      expect(validateClientMessage(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('single-player link: sessions', () => {
  it('is accepted, shows in the owner list with its status, and is forgotten on close', async () => {
    const s = await server();
    const o = await owner(s);
    const { c, spId } = await spGame(s, 'Aurora');
    await sleep(40);
    const l = await list(o);
    expect(l.spTotal).toBe(1);
    expect(l.sp).toEqual([{ spId, nation: 'Aurora', map: 'Pangaea, small', minutes: 3, landPct: 12.3, linkedMinutes: 0 }]);
    expect(l.rooms).toEqual([]);
    // not a player: no lobby list, no welcome
    expect(c.has('lobbyList')).toBe(false);
    expect(c.has('welcome')).toBe(false);
    c.close();
    await sleep(80);
    const l2 = await list(o);
    expect(l2.sp).toEqual([]);
    expect(s.hub.spLinks.size).toBe(0);
    expect(s.hub.sessions.size).toBe(1);
  });

  it('outlives the hello timeout (it never says hello)', async () => {
    const s = await server({ helloTimeoutMs: 100 });
    const { c } = await spGame(s);
    await sleep(300);
    expect(c.closeCode).toBeNull();
    expect(s.hub.spLinks.size).toBe(1);
  });

  it('keeps one status per 5 s and drops the rest silently', async () => {
    const s = await server();
    const o = await owner(s);
    const { c } = await spGame(s, 'First');
    await sleep(30);
    c.send(status('Second', 9, 50));
    await sleep(40);
    expect((await list(o)).sp[0]).toMatchObject({ nation: 'First', minutes: 3 });
    expect(c.has('error')).toBe(false);
  });

  it('a link with another protocol is closed quietly (version)', async () => {
    const s = await server();
    const c = await client(s);
    c.send({ type: 'spHello', protocol: PROTOCOL_VERSION - 1 });
    expect(await c.closed()).toBe(CloseCode.Version);
    expect(s.hub.spLinks.size).toBe(0);
  });

  it('may send nothing but spStatus and ping: no chat, intents, lobbies, hello or owner powers', async () => {
    const s = await server();
    const { c } = await spGame(s);
    const tries: unknown[] = [
      { type: 'hello', protocol: PROTOCOL_VERSION, name: 'X', color: [1, 2, 3], clientId: makeClientId() },
      { type: 'spHello', protocol: PROTOCOL_VERSION },
      { type: 'chat', channel: 'all', text: 'hi' },
      { type: 'intent', action: { type: 'startNow' } },
      { type: 'createLobby', settings: {} },
      { type: 'joinLobby', code: 'ABCDEF' },
      { type: 'adminAuth', code: TEST_CODE },
      { type: 'adminRooms' },
      { type: 'adminAnnounce', scope: 'all', title: '', text: 'Hi', style: 'info', seconds: 6 },
      { type: 'hash', turn: 9, hash: 1 },
    ];
    for (const t of tries) c.send(t);
    c.send({ type: 'ping', t: 5 });
    await c.take('pong');
    let refused = 0;
    for (const m of c.inbox) if (m.type === 'error' && m.code === 'notAllowed') refused++;
    expect(refused).toBe(tries.length);
    expect(c.has('adminAuth')).toBe(false);
    expect(c.has('lobbyState')).toBe(false);
    expect(s.hub.rooms.size).toBe(0);
    // the code it tried did not make anything an owner
    expect(s.hub.admin.isAdmin('')).toBe(false);
  });

  it('is closed after a stream of messages it may not send, and for a long frame', async () => {
    const s = await server();
    const { c } = await spGame(s);
    for (let i = 0; i < 30; i++) c.send({ type: 'chat', channel: 'all', text: 'hi' });
    expect(await c.closed()).toBe(CloseCode.BadClient);
    const { c: c2 } = await spGame(s);
    c2.send({ ...status(), pad: 'x'.repeat(SP_MESSAGE_MAX_BYTES) });
    await c2.take('error', (m) => m.code === 'badMessage');
  });

  it('a player session may not send spStatus, nor spHello after hello', async () => {
    const s = await server();
    const p = await player(s, 'Ann');
    p.send(status());
    await p.take('error', (m) => m.code === 'notAllowed');
    p.send({ type: 'spHello', protocol: PROTOCOL_VERSION });
    await p.take('error', (m) => m.code === 'notAllowed');
    expect(s.hub.spLinks.size).toBe(0);
  });

  it('counts against the per-address limits and the server-wide cap', async () => {
    const s = await server({ maxConnectionsPerIp: 3, maxSpSessionsPerIp: 2 });
    await spGame(s);
    await spGame(s);
    // a third link from the address is refused, which leaves room for a player
    const c3 = await client(s);
    c3.send({ type: 'spHello', protocol: PROTOCOL_VERSION });
    expect(await c3.closed()).toBe(CloseCode.TooManyConnections);
    await sleep(30);
    await player(s, 'Still fits');
    // the address is now full: the socket itself is refused
    await expect(Client.connect(s.wsUrl)).rejects.toBeTruthy();
    await srv!.close();
    const s2 = await server({ maxSpSessions: 1 });
    await spGame(s2);
    const c = await client(s2);
    c.send({ type: 'spHello', protocol: PROTOCOL_VERSION });
    expect(await c.closed()).toBe(CloseCode.TooManyConnections);
  });
});

describe('single-player link: owner messages', () => {
  it('reach one game, all single-player games, and every screen; nothing else does', async () => {
    const s = await server();
    const o = await owner(s);
    const a = await spGame(s, 'Aurora');
    const b = await spGame(s, 'Borealis');
    const p = await player(s, 'Online');
    // one game
    o.send({ type: 'adminAnnounce', scope: 'sp', spId: a.spId, title: 'Hi', text: 'Just you', style: 'info', seconds: 6 });
    expect((await o.take('adminAck')).reached).toBe(1);
    expect((await a.c.take('announcement')).text).toBe('Just you');
    o.send({ type: 'adminNotice', spId: b.spId, text: 'A message', style: 'warning' });
    expect((await o.take('adminAck')).ok).toBe(true);
    expect(await b.c.take('notice')).toMatchObject({ text: 'A message', style: 'warning' });
    o.send({ type: 'adminSpectacle', scope: 'sp', spId: b.spId, kind: 'flip', mode: 'mirror', seconds: 4 });
    await o.take('adminAck');
    expect(await b.c.take('spectacle')).toEqual({ type: 'spectacle', kind: 'flip', mode: 'mirror', seconds: 4 });
    // all single-player games: not the online player (a second owner session: each has its own rate limit)
    const o2 = await owner(s);
    o2.send({ type: 'adminSpectacle', scope: 'sp', kind: 'ducks' });
    expect((await o2.take('adminAck')).reached).toBe(2);
    await a.c.take('spectacle', (m) => m.kind === 'ducks');
    await b.c.take('spectacle', (m) => m.kind === 'ducks');
    o2.send({ type: 'adminAnnounce', scope: 'sp', title: '', text: 'Solo folks', style: 'celebration', seconds: 8 });
    expect((await o2.take('adminAck')).reached).toBe(2);
    await a.c.take('announcement', (m) => m.text === 'Solo folks');
    await b.c.take('announcement', (m) => m.text === 'Solo folks');
    // every screen: the player, the owner sessions and both links
    const o3 = await owner(s);
    o3.send({ type: 'adminAnnounce', scope: 'all', title: '', text: 'Everyone', style: 'info', seconds: 6 });
    expect((await o3.take('adminAck')).reached).toBe(6);
    for (const c of [a.c, b.c, p, o, o2, o3]) await c.take('announcement', (m) => m.text === 'Everyone');
    o3.send({ type: 'adminSpectacle', scope: 'all', kind: 'confetti' });
    await o3.take('adminAck');
    for (const c of [a.c, b.c, p]) await c.take('spectacle', (m) => m.kind === 'confetti');
    await sleep(40);
    expect(p.inbox.some((m) => (m.type === 'announcement' && m.text !== 'Everyone') || m.type === 'notice' || (m.type === 'spectacle' && m.kind !== 'confetti'))).toBe(false);
    expect(a.c.has('notice')).toBe(false);
    // a link only ever hears these three kinds
    for (const c of [a.c, b.c]) for (const m of c.inbox) expect(['announcement', 'notice', 'spectacle']).toContain(m.type);
  });

  it('a gone game is reported to the owner', async () => {
    const s = await server();
    const o = await owner(s);
    const a = await spGame(s);
    a.c.close();
    await sleep(60);
    o.send({ type: 'adminNotice', spId: a.spId, text: 'Hello?', style: 'info' });
    expect(await o.take('adminAck')).toMatchObject({ ok: false, reached: 0 });
  });

  it('are refused from anyone who is not the owner', async () => {
    const s = await server();
    const a = await spGame(s);
    const p = await player(s, 'Mallory');
    const tries: unknown[] = [
      { type: 'adminRooms' },
      { type: 'adminAnnounce', scope: 'sp', title: '', text: 'Fake', style: 'info', seconds: 6 },
      { type: 'adminAnnounce', scope: 'sp', spId: a.spId, title: '', text: 'Fake', style: 'info', seconds: 6 },
      { type: 'adminNotice', spId: a.spId, text: 'Fake', style: 'info' },
      { type: 'adminSpectacle', scope: 'sp', spId: a.spId, kind: 'fakeBomb' },
    ];
    for (const t of tries) p.send(t);
    p.send({ type: 'ping' });
    await p.take('pong');
    expect(p.inbox.filter((m) => m.type === 'error' && m.code === 'notAllowed').length).toBe(tries.length);
    await sleep(40);
    expect(a.c.inbox).toEqual([]);
  });

  it('a broadcast to all single-player games costs like one for every screen (rate limit)', async () => {
    const s = await server();
    const o = await owner(s);
    await spGame(s);
    for (let i = 0; i < 4; i++) o.send({ type: 'adminSpectacle', scope: 'sp', kind: 'shake' });
    const acks: Msg<'adminAck'>[] = [];
    for (let i = 0; i < 2; i++) acks.push(await o.take('adminAck'));
    await o.take('error', (m) => m.code === 'rateLimit');
    expect(acks.every((a) => a.ok)).toBe(true);
  });
});
