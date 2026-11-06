// Screen pranks and the owner's time rules on the server (server/validate.ts, server/hub.ts): only a session that
// proved the code may send them; the kinds are an exact list; every banner, countdown and prank has a capped length
// (15 s for banners and countdowns, 10 s for pranks); a prank for one player reaches that player alone. The code here
// is made up for the tests.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ANNOUNCE_SECONDS, COUNTDOWN_SECONDS, NOTICE_SECONDS, PRANK_KINDS, PRANK_SECONDS, PROTOCOL_VERSION, makeClientId } from '../src/net/protocol';
import type { ServerMessage } from '../src/net/protocol';
import { startServer } from '../server/server';
import type { RunningServer } from '../server/server';
import { validateClientMessage } from '../server/validate';

const TEST_CODE = 'not-the-real-one-1234';
type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Client {
  readonly inbox: ServerMessage[] = [];
  clientId = makeClientId();
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString()) as ServerMessage));
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
    this.ws.send(JSON.stringify(m));
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
  async hello(name: string): Promise<void> {
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, name, color: [10, 20, 30], clientId: this.clientId, build: 'test' });
    await this.take('welcome');
  }
  async auth(code = TEST_CODE): Promise<boolean> {
    this.send({ type: 'adminAuth', code });
    return (await this.take('adminAuth')).ok;
  }
  close(): void {
    this.ws.close();
  }
}

const base = { port: 0, host: '127.0.0.1', publicLobbies: false, turnMs: 30, firstTurnDelayMs: 0, sweepMs: 20, createLobbyCooldownMs: 0, maxRoomsPerIp: 50, log: () => {} };

async function connected(srv: RunningServer, name: string): Promise<Client> {
  const c = await Client.connect(srv.wsUrl);
  await c.hello(name);
  return c;
}

async function privateGame(srv: RunningServer, names: string[]): Promise<{ cs: Client[]; code: string }> {
  const cs: Client[] = [];
  for (const n of names) cs.push(await connected(srv, n));
  cs[0].send({ type: 'createLobby', settings: { map: { kind: 'generated', type: 'pangaea', size: 'small' }, aiCount: 1 } });
  const { code } = await cs[0].take('lobbyState');
  for (const c of cs.slice(1)) {
    c.send({ type: 'joinLobby', code });
    await c.take('lobbyState');
  }
  cs[0].send({ type: 'startGame' });
  for (const c of cs) await c.take('gameStart');
  return { cs, code };
}

const ok = (m: unknown): boolean => validateClientMessage(m).ok;

describe('pranks and time caps: validation', () => {
  it('every prank kind is accepted alone, with seconds in range, and comes back without extra fields', () => {
    for (const kind of PRANK_KINDS) {
      expect(ok({ type: 'adminSpectacle', scope: 'room', kind }), kind).toBe(true);
      expect(ok({ type: 'adminSpectacle', scope: 'all', kind, seconds: PRANK_SECONDS[1] }), kind).toBe(true);
    }
    expect(validateClientMessage({ type: 'adminSpectacle', scope: 'room', code: 'abcdef', memberId: 4, kind: 'flip', mode: 'mirror', seconds: 6, junk: 1 })).toEqual({
      ok: true,
      value: { type: 'adminSpectacle', scope: 'room', code: 'ABCDEF', memberId: 4, kind: 'flip', mode: 'mirror', seconds: 6 },
    });
  });

  it('prank lengths are capped at 10 s, banners and countdowns at 15 s', () => {
    for (const kind of PRANK_KINDS) {
      expect(ok({ type: 'adminSpectacle', scope: 'room', kind, seconds: PRANK_SECONDS[1] + 1 }), kind).toBe(false);
      expect(ok({ type: 'adminSpectacle', scope: 'room', kind, seconds: PRANK_SECONDS[0] - 1 }), kind).toBe(false);
      expect(ok({ type: 'adminSpectacle', scope: 'room', kind, seconds: 4.5 }), kind).toBe(false);
    }
    expect(PRANK_SECONDS[1]).toBe(10);
    expect(ANNOUNCE_SECONDS[1]).toBe(15);
    expect(COUNTDOWN_SECONDS[1]).toBe(15);
    expect(NOTICE_SECONDS).toBe(5);
    const ann = { type: 'adminAnnounce', scope: 'room', title: '', text: 'hi', style: 'info' };
    expect(ok({ ...ann, seconds: 15 })).toBe(true);
    expect(ok({ ...ann, seconds: 16 })).toBe(false);
    expect(ok({ ...ann, seconds: 60 })).toBe(false);
    expect(ok({ type: 'adminSpectacle', scope: 'room', kind: 'countdown', seconds: 15 })).toBe(true);
    expect(ok({ type: 'adminSpectacle', scope: 'room', kind: 'countdown', seconds: 16 })).toBe(false);
    expect(ok({ type: 'adminSpectacle', scope: 'room', kind: 'countdown', seconds: 600 })).toBe(false);
  });

  it('refuses unknown kinds, a mode off a flip, a tile or label on a prank, and one player on every screen', () => {
    const bad: unknown[] = [
      { type: 'adminSpectacle', scope: 'room', kind: 'nuke' },
      { type: 'adminSpectacle', scope: 'room', kind: 'fakeWin' },
      { type: 'adminSpectacle', scope: 'room', kind: 'FLIP' },
      { type: 'adminSpectacle', scope: 'room', kind: 'flip', mode: 'sideways' },
      { type: 'adminSpectacle', scope: 'room', kind: 'disco', mode: 'mirror' },
      { type: 'adminSpectacle', scope: 'room', kind: 'fakeBomb', tile: 3 },
      { type: 'adminSpectacle', scope: 'room', kind: 'ducks', label: 'quack' },
      { type: 'adminSpectacle', scope: 'all', kind: 'chase', memberId: 2 },
      { type: 'adminSpectacle', scope: 'room', kind: 'chase', memberId: -1 },
      { type: 'adminSpectacle', scope: 'room', kind: 'shake', seconds: 3 },
    ];
    for (const m of bad) expect(ok(m), JSON.stringify(m)).toBe(false);
  });
});

describe('pranks: server', () => {
  let srv: RunningServer;
  const open: Client[] = [];
  const track = <T extends Client | Client[]>(c: T): T => {
    open.push(...(Array.isArray(c) ? c : [c]));
    return c;
  };
  beforeAll(async () => {
    srv = await startServer({ ...base, adminCode: TEST_CODE });
  });
  afterEach(() => {
    for (const c of open.splice(0)) c.close();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('no prank from a player, a spectator or a session on the lobby list; nobody sees anything', async () => {
    const { cs, code } = await privateGame(srv, ['Host', 'Guest']);
    track(cs);
    const spec = track(await connected(srv, 'Spec'));
    spec.send({ type: 'joinLobby', code, spectate: true });
    await spec.take('gameStart');
    const lone = track(await connected(srv, 'Lone'));
    const hostId = srv.hub.rooms.get(code)!.members.find((m) => m.name === 'Host')!.memberId;
    for (const who of [cs[1], spec, lone]) {
      for (const kind of PRANK_KINDS) {
        who.send({ type: 'adminSpectacle', scope: 'room', code, memberId: hostId, kind });
        expect((await who.take('error')).code, kind).toBe('notAllowed');
      }
    }
    await sleep(80);
    for (const c of [...cs, spec, lone]) expect(c.has('spectacle')).toBe(false);
  });

  it('a prank for one player reaches that player alone; one for the game reaches all; lengths pass through', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const g = await privateGame(srv, ['P1', 'P2']);
    track(g.cs);
    const p2 = srv.hub.rooms.get(g.code)!.members.find((m) => m.name === 'P2')!.memberId;
    owner.send({ type: 'adminSpectacle', scope: 'room', code: g.code, memberId: p2, kind: 'flip', mode: 'mirror', seconds: 4 });
    expect(await owner.take('adminAck')).toMatchObject({ ok: true, reached: 1 });
    expect(await g.cs[1].take('spectacle')).toEqual({ type: 'spectacle', kind: 'flip', mode: 'mirror', seconds: 4 });
    await sleep(60);
    expect(g.cs[0].has('spectacle')).toBe(false);
    owner.send({ type: 'adminSpectacle', scope: 'room', code: g.code, kind: 'ducks' });
    expect((await owner.take('adminAck')).ok).toBe(true);
    for (const c of g.cs) expect(await c.take('spectacle')).toEqual({ type: 'spectacle', kind: 'ducks' });
    owner.send({ type: 'adminSpectacle', scope: 'room', code: g.code, memberId: 999, kind: 'disco' });
    expect(await owner.take('adminAck')).toMatchObject({ ok: false, message: 'That player is not connected' });
    // too long: refused before anyone sees it
    owner.send({ type: 'adminSpectacle', scope: 'room', code: g.code, kind: 'earthquake', seconds: 30 });
    expect((await owner.take('error')).code).toBe('badMessage');
    await sleep(60);
    for (const c of g.cs) expect(c.has('spectacle')).toBe(false);
  });

  it('a notice lasts NOTICE_SECONDS', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const g = await privateGame(srv, ['Q1']);
    track(g.cs);
    const q1 = srv.hub.rooms.get(g.code)!.members[0].memberId;
    owner.send({ type: 'adminNotice', code: g.code, memberId: q1, text: 'Hi', style: 'info' });
    expect((await g.cs[0].take('notice')).seconds).toBe(NOTICE_SECONDS);
  });
});
