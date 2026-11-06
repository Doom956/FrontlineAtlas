// Owner powers online (server/hub.ts adminPower, room.ts, validate.ts, the sim's player-0 console actions): only a
// session that proved the code may list rooms, announce, message, show effects, mute and remove; announcements reach
// every room and the lobby list; a watching owner may send console actions and nothing else. The code here is made
// up for the tests.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BROADCAST_TEXT_MAX, PROTOCOL_VERSION, cleanBroadcastText, clipBroadcastText, makeClientId } from '../src/net/protocol';
import type { ServerMessage } from '../src/net/protocol';
import { startServer } from '../server/server';
import type { RunningServer } from '../server/server';
import { validateClientMessage } from '../server/validate';
import { AdminLimiter, ADMIN_POWER_LIMITS } from '../server/admin';
import { applyAction } from '../src/sim/actions';
import { hashState } from '../src/sim/hash';
import type { Action } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const TEST_CODE = 'made-up-test-code';
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

/** A started private game: the clients in order (the first is the host), and its code. */
async function privateGame(srv: RunningServer, names: string[], start = true): Promise<{ cs: Client[]; code: string }> {
  const cs: Client[] = [];
  for (const n of names) cs.push(await connected(srv, n));
  cs[0].send({ type: 'createLobby', settings: { map: { kind: 'generated', type: 'pangaea', size: 'small' }, aiCount: 1 } });
  const { code } = await cs[0].take('lobbyState');
  for (const c of cs.slice(1)) {
    c.send({ type: 'joinLobby', code });
    await c.take('lobbyState');
  }
  if (start) {
    cs[0].send({ type: 'startGame' });
    for (const c of cs) await c.take('gameStart');
  }
  return { cs, code };
}

const relayedAdmin = (c: Client, playerId: number): boolean =>
  c.inbox.some((m) => m.type === 'turn' && m.intents.some((i) => i.action.type === 'admin' && i.playerId === playerId));

/** One of each owner power, aimed at `code`. */
const everyPower = (code: string, memberId: number): unknown[] => [
  { type: 'adminRooms' },
  { type: 'adminAnnounce', scope: 'all', title: '', text: 'Hello all', style: 'info', seconds: 8 },
  { type: 'adminAnnounce', scope: 'room', code, title: 'Hi', text: 'Hello room', style: 'warning', seconds: 8 },
  { type: 'adminNotice', code, memberId, text: 'Hello you', style: 'info' },
  { type: 'adminSpectacle', scope: 'room', code, kind: 'ping', tile: 5, label: 'Here' },
  { type: 'adminSpectacle', scope: 'all', kind: 'confetti' },
  { type: 'adminSpectacle', scope: 'room', code, kind: 'countdown', seconds: 10 },
  { type: 'adminSpectacle', scope: 'room', code, memberId, kind: 'flip', mode: 'mirror', seconds: 5 },
  { type: 'adminSpectacle', scope: 'all', kind: 'ducks' },
  { type: 'adminMute', code, memberId, minutes: 5 },
  { type: 'adminKick', code, memberId },
];

// ------------------------------------------------------------------------------------------------ validation

describe('owner powers: message validation', () => {
  it('accepts well-formed powers and rebuilds them without extra fields', () => {
    const r = validateClientMessage({ type: 'adminAnnounce', scope: 'room', code: 'abcdef', title: ' Big  news ', text: 'Peace\u0000 ends‮ soon', style: 'celebration', seconds: 12, extra: 1 });
    expect(r).toEqual({ ok: true, value: { type: 'adminAnnounce', scope: 'room', code: 'ABCDEF', title: 'Big news', text: 'Peace ends soon', style: 'celebration', seconds: 12 } });
    expect(validateClientMessage({ type: 'adminRooms', junk: true })).toEqual({ ok: true, value: { type: 'adminRooms' } });
    expect(validateClientMessage({ type: 'adminSpectacle', scope: 'all', kind: 'shake' }).ok).toBe(true);
    expect(validateClientMessage({ type: 'adminSpectacle', scope: 'room', kind: 'fireworks', tile: 99 }).ok).toBe(true);
    expect(validateClientMessage({ type: 'adminMute', memberId: 3, minutes: 0 }).ok).toBe(true);
  });

  it('refuses bad payloads', () => {
    const bad: unknown[] = [
      { type: 'adminAnnounce', scope: 'room', title: '', text: '', style: 'info', seconds: 8 },
      { type: 'adminAnnounce', scope: 'room', title: '', text: '   \u0007  ', style: 'info', seconds: 8 },
      { type: 'adminAnnounce', scope: 'room', title: '', text: 'x'.repeat(BROADCAST_TEXT_MAX + 1), style: 'info', seconds: 8 },
      { type: 'adminAnnounce', scope: 'room', title: 'x'.repeat(41), text: 'hi', style: 'info', seconds: 8 },
      { type: 'adminAnnounce', scope: 'everywhere', title: '', text: 'hi', style: 'info', seconds: 8 },
      { type: 'adminAnnounce', scope: 'room', title: '', text: 'hi', style: 'shout', seconds: 8 },
      { type: 'adminAnnounce', scope: 'room', title: '', text: 'hi', style: 'info', seconds: 2 },
      { type: 'adminAnnounce', scope: 'room', title: '', text: 'hi', style: 'info', seconds: 61 },
      { type: 'adminAnnounce', scope: 'room', title: '', text: 42, style: 'info', seconds: 8 },
      { type: 'adminAnnounce', scope: 'room', code: 'nope!', title: '', text: 'hi', style: 'info', seconds: 8 },
      { type: 'adminNotice', memberId: -1, text: 'hi', style: 'info' },
      { type: 'adminNotice', memberId: 1, text: '', style: 'info' },
      { type: 'adminSpectacle', scope: 'room', kind: 'ping' },
      { type: 'adminSpectacle', scope: 'all', kind: 'ping', tile: 3 },
      { type: 'adminSpectacle', scope: 'room', kind: 'laser' },
      { type: 'adminSpectacle', scope: 'room', kind: 'shake', tile: 3 },
      { type: 'adminSpectacle', scope: 'room', kind: 'confetti', label: 'hi' },
      { type: 'adminSpectacle', scope: 'room', kind: 'countdown' },
      { type: 'adminSpectacle', scope: 'room', kind: 'countdown', seconds: 9999 },
      { type: 'adminSpectacle', scope: 'room', kind: 'shake', seconds: 5 },
      { type: 'adminSpectacle', scope: 'room', kind: 'ping', tile: 1.5 },
      { type: 'adminMute', memberId: 1, minutes: 24 * 60 + 1 },
      { type: 'adminMute', memberId: 1 },
      { type: 'adminKick', memberId: 'one' },
    ];
    for (const m of bad) expect(validateClientMessage(m).ok, JSON.stringify(m)).toBe(false);
  });

  it('cleans text: control, zero-width and bidi characters out, one line, length capped', () => {
    expect(cleanBroadcastText('a\nb\tc​d⁦e', 50)).toBe('a b c d e');
    expect(cleanBroadcastText('x'.repeat(201), 200)).toBeNull();
    expect(cleanBroadcastText(7, 200)).toBeNull();
    expect(clipBroadcastText('y'.repeat(500), 200)).toBe('y'.repeat(200));
    expect(clipBroadcastText({ toString: () => 'evil' }, 10)).toBe('');
  });

  it('the limiter: a burst, then one per interval; a server-wide broadcast costs more', () => {
    let now = 0;
    const l = new AdminLimiter(() => now);
    const burst = ADMIN_POWER_LIMITS.show.burst;
    for (let k = 0; k < burst; k++) expect(l.take('show')).toBe(true);
    expect(l.take('show')).toBe(false);
    expect(l.take('list')).toBe(true); // other kinds have their own budget
    now += ADMIN_POWER_LIMITS.show.everyMs;
    expect(l.take('show', 2)).toBe(false);
    expect(l.take('show')).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ server

describe('owner powers: server', () => {
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

  it('every power is refused for sessions without the code: a player, a spectator, one on the lobby list', async () => {
    const { cs, code } = await privateGame(srv, ['Host', 'Guest']);
    track(cs);
    const [host, guest] = cs;
    const spec = track(await connected(srv, 'Spec'));
    spec.send({ type: 'joinLobby', code, spectate: true });
    await spec.take('gameStart');
    const lone = track(await connected(srv, 'Lone'));
    expect(await guest.auth('a wrong guess')).toBe(false);
    const room = srv.hub.rooms.get(code)!;
    const hostId = room.members.find((m) => m.name === 'Host')!.memberId;
    for (const who of [guest, spec, lone]) {
      for (const m of everyPower(code, hostId)) {
        who.send(m);
        const e = await who.take('error');
        expect(e.code, JSON.stringify(m)).toBe('notAllowed');
      }
    }
    await sleep(100);
    for (const c of [host, guest, spec, lone]) {
      for (const t of ['announcement', 'notice', 'spectacle', 'kicked', 'adminRooms', 'adminAck'] as const) expect(c.has(t), `${t}`).toBe(false);
    }
    expect(room.isMuted(hostId)).toBe(false);
    expect(room.members.some((m) => m.name === 'Host' && m.session)).toBe(true);
    // a spectator without the code can't send console actions either
    spec.send({ type: 'intent', action: { type: 'admin', op: 'freezeAI', flag: true } });
    expect((await spec.take('error')).code).toBe('notAllowed');
  });

  it('lists every room with its people', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const a = await privateGame(srv, ['A1', 'A2']);
    const b = await privateGame(srv, ['B1'], false);
    track(a.cs);
    track(b.cs);
    owner.send({ type: 'adminRooms' });
    const list = await owner.take('adminRooms');
    const ra = list.rooms.find((r) => r.code === a.code)!;
    const rb = list.rooms.find((r) => r.code === b.code)!;
    expect(ra).toMatchObject({ phase: 'running', isPublic: false, players: 2, connected: 2 });
    expect(ra.members.map((m) => m.name).sort()).toEqual(['A1', 'A2']);
    expect(ra.members.every((m) => m.playerId > 0 && !m.spectator && m.connected && m.mutedMinutes === 0)).toBe(true);
    expect(rb).toMatchObject({ phase: 'lobby', players: 1 });
    expect(list.total).toBeGreaterThanOrEqual(2);
    // running games come first
    expect(list.rooms.findIndex((r) => r.code === a.code)).toBeLessThan(list.rooms.findIndex((r) => r.code === b.code));
  });

  it('an announcement for all reaches every room, every lobby and the lobby list; one for a room only that room', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const g = await privateGame(srv, ['G1', 'G2']);
    const l = await privateGame(srv, ['L1'], false);
    track(g.cs);
    track(l.cs);
    const idle = track(await connected(srv, 'Idle'));
    const spec = track(await connected(srv, 'Watcher'));
    spec.send({ type: 'joinLobby', code: g.code, spectate: true });
    await spec.take('gameStart');
    owner.send({ type: 'adminAnnounce', scope: 'all', title: '', text: 'Server restarts in 5 minutes', style: 'warning', seconds: 12 });
    const ack = await owner.take('adminAck');
    expect(ack).toMatchObject({ what: 'adminAnnounce', ok: true });
    expect(ack.reached).toBeGreaterThanOrEqual(6);
    for (const c of [...g.cs, ...l.cs, idle, spec, owner]) {
      expect(await c.take('announcement')).toEqual({ type: 'announcement', title: '', text: 'Server restarts in 5 minutes', style: 'warning', seconds: 12 });
    }
    owner.send({ type: 'adminAnnounce', scope: 'room', code: g.code, title: 'Round two', text: 'Peace ends now', style: 'celebration', seconds: 8 });
    expect((await owner.take('adminAck')).ok).toBe(true);
    for (const c of [...g.cs, spec]) expect((await c.take('announcement')).title).toBe('Round two');
    await sleep(80);
    for (const c of [...l.cs, idle, owner]) expect(c.has('announcement')).toBe(false);
    // a room scope without a code means the owner's own room: here there is none
    owner.send({ type: 'adminAnnounce', scope: 'room', title: '', text: 'x', style: 'info', seconds: 8 });
    expect((await owner.take('adminAck')).ok).toBe(false);
    owner.send({ type: 'adminAnnounce', scope: 'room', code: 'ZZZZZZ', title: '', text: 'x', style: 'info', seconds: 8 });
    expect(await owner.take('adminAck')).toMatchObject({ ok: false, message: 'No game with that code' });
  });

  it('a notice reaches one player; effects reach the room; tile effects carry the room code', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const g = await privateGame(srv, ['N1', 'N2']);
    track(g.cs);
    const room = srv.hub.rooms.get(g.code)!;
    const n2 = room.members.find((m) => m.name === 'N2')!.memberId;
    owner.send({ type: 'adminNotice', code: g.code, memberId: n2, text: 'Nice defence', style: 'celebration' });
    expect((await owner.take('adminAck')).ok).toBe(true);
    expect(await g.cs[1].take('notice')).toMatchObject({ text: 'Nice defence', style: 'celebration' });
    await sleep(60);
    expect(g.cs[0].has('notice')).toBe(false);
    owner.send({ type: 'adminSpectacle', scope: 'room', code: g.code, kind: 'ping', tile: 42, label: 'Look here' });
    for (const c of g.cs) expect(await c.take('spectacle')).toEqual({ type: 'spectacle', kind: 'ping', tile: 42, code: g.code, label: 'Look here' });
    owner.send({ type: 'adminSpectacle', scope: 'room', code: g.code, kind: 'countdown', seconds: 10, label: 'Event in' });
    for (const c of g.cs) expect(await c.take('spectacle')).toEqual({ type: 'spectacle', kind: 'countdown', seconds: 10, label: 'Event in' });
  });

  it('a watching owner sends console actions (player 0) and nothing else; turns still pass the sim rules', async () => {
    const g = await privateGame(srv, ['P1', 'P2']);
    track(g.cs);
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    owner.send({ type: 'joinLobby', code: g.code, spectate: true });
    expect((await owner.take('gameStart')).yourPlayerId).toBe(0);
    owner.send({ type: 'intent', action: { type: 'admin', op: 'addResource', player: 1, key: 'gold', amount: 500 } });
    await g.cs[0].take('turn', (m) => m.intents.some((i) => i.action.type === 'admin' && i.playerId === 0));
    owner.send({ type: 'intent', action: { type: 'setAuto', mix: true } });
    expect(await owner.take('error')).toMatchObject({ code: 'notAllowed', message: 'Spectators cannot act' });
    owner.send({ type: 'intent', action: { type: 'spawn', tile: 3 } });
    expect((await owner.take('error')).code).toBe('notAllowed');
    await sleep(120);
    const fromOwner = g.cs[1].inbox.filter((m) => m.type === 'turn' && m.intents.some((i) => i.playerId === 0 && i.action.type !== 'admin'));
    expect(fromOwner).toEqual([]);
    // the spectator count is the only trace: an anonymous number, like any spectator
    const pres = await g.cs[0].take('presence', (m) => m.spectators === 1);
    expect(JSON.stringify(pres)).not.toContain('Owner');
  });

  it('rate limits the powers per session (a server-wide banner costs double)', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const ann = { type: 'adminAnnounce', scope: 'all', title: '', text: 'spam', style: 'info', seconds: 5 };
    for (let k = 0; k < 4; k++) owner.send(ann);
    await sleep(150);
    const acks = owner.inbox.filter((m) => m.type === 'adminAck').length;
    const limited = owner.inbox.filter((m) => m.type === 'error' && m.code === 'rateLimit').length;
    expect(acks).toBe(Math.floor(ADMIN_POWER_LIMITS.show.burst / 2));
    expect(limited).toBe(4 - acks);
    // the room list has its own budget
    owner.send({ type: 'adminRooms' });
    await owner.take('adminRooms');
  });

  it('mute: kept by the room (and its list), lifted with 0 minutes', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const g = await privateGame(srv, ['M1', 'M2']);
    track(g.cs);
    const room = srv.hub.rooms.get(g.code)!;
    const m2 = room.members.find((m) => m.name === 'M2')!.memberId;
    expect(room.isMuted(m2)).toBe(false);
    owner.send({ type: 'adminMute', code: g.code, memberId: m2, minutes: 15 });
    expect(await owner.take('adminAck')).toMatchObject({ ok: true, message: 'Muted for 15 min' });
    expect(room.isMuted(m2)).toBe(true);
    expect(room.isMuted(room.members.find((m) => m.name === 'M1')!.memberId)).toBe(false);
    owner.send({ type: 'adminRooms' });
    const list = await owner.take('adminRooms');
    expect(list.rooms.find((r) => r.code === g.code)!.members.find((m) => m.memberId === m2)!.mutedMinutes).toBe(15);
    owner.send({ type: 'adminMute', code: g.code, memberId: m2, minutes: 0 });
    expect(await owner.take('adminAck')).toMatchObject({ ok: true, message: 'Mute lifted' });
    expect(room.isMuted(m2)).toBe(false);
    owner.send({ type: 'adminMute', code: g.code, memberId: 9999, minutes: 5 });
    expect((await owner.take('adminAck')).ok).toBe(false);
    // nothing is said to the muted player (the chat tells them when they try)
    expect(g.cs[1].has('notice')).toBe(false);
  });

  it("the owner's mute and remove apply to chat", async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const g = await privateGame(srv, ['C1', 'C2']);
    track(g.cs);
    const [c1, c2] = g.cs;
    const spec = track(await connected(srv, 'Watcher'));
    spec.send({ type: 'joinLobby', code: g.code, spectate: true });
    await spec.take('gameStart');
    const room = srv.hub.rooms.get(g.code)!;
    const id2 = room.members.find((m) => m.name === 'C2')!.memberId;
    const idSpec = room.members.find((m) => m.name === 'Watcher')!.memberId;
    c2.send({ type: 'chat', channel: 'all', text: 'before' });
    await c1.take('chat', (m) => m.entry.text === 'before');
    // muted: refused with a note to the sender alone, nobody else gets it
    owner.send({ type: 'adminMute', code: g.code, memberId: id2, minutes: 5 });
    expect((await owner.take('adminAck')).ok).toBe(true);
    c2.send({ type: 'chat', channel: 'all', text: 'while muted' });
    const n = await c2.take('chatNotice');
    expect(n.reason).toBe('muted');
    expect(n.text).toBe("You can't send messages in this game for 5 more minutes.");
    // the mute is kept by clientId: reconnecting doesn't lift it
    const back = track(await Client.connect(srv.wsUrl));
    back.clientId = c2.clientId;
    c2.close();
    back.send({ type: 'hello', protocol: PROTOCOL_VERSION, name: 'C2', color: [1, 2, 3], clientId: back.clientId, build: 'test', resume: { code: g.code, haveTurns: 0 } });
    expect((await back.take('welcome')).resumed).toBe(g.code);
    await back.take('chatHistory');
    expect(room.isMuted(id2)).toBe(true);
    // (notes to one member come at most every 1.5 s, so this one is refused without a second note)
    back.send({ type: 'chat', channel: 'all', text: 'after reconnect' });
    // lifted: chat works again
    owner.send({ type: 'adminMute', code: g.code, memberId: id2, minutes: 0 });
    expect((await owner.take('adminAck')).ok).toBe(true);
    back.send({ type: 'chat', channel: 'all', text: 'free again' });
    await c1.take('chat', (m) => m.entry.text === 'free again');
    await sleep(60);
    const seen = (c: Client): string[] => c.inbox.flatMap((m) => (m.type === 'chat' ? [m.entry.text] : []));
    expect(seen(c1)).not.toContain('while muted');
    expect(seen(c1)).not.toContain('after reconnect');
    expect(seen(spec)).not.toContain('while muted');
    // a removed spectator can't chat and reads nothing more
    owner.send({ type: 'adminKick', code: g.code, memberId: idSpec });
    expect((await owner.take('adminAck')).ok).toBe(true);
    expect((await spec.take('kicked')).reason).toBe('You were removed from this game');
    spec.send({ type: 'chat', channel: 'all', text: 'let me back' });
    expect((await spec.take('error')).code).toBe('notInLobby');
    c1.send({ type: 'chat', channel: 'all', text: 'after the removal' });
    await back.take('chat', (m) => m.entry.text === 'after the removal');
    await sleep(60);
    expect(seen(spec)).not.toContain('after the removal');
    expect(seen(c1)).not.toContain('let me back');
  });

  it('remove and mute also hold for a new clientId from the same address; the owner and members already in are not touched', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    // every test client connects from 127.0.0.1: 'Mate' plays for the same address as the troublemaker
    const l = await privateGame(srv, ['Host', 'Bad', 'Mate'], false);
    track(l.cs);
    const [host, bad, mate] = l.cs;
    const room = srv.hub.rooms.get(l.code)!;
    const idOf = (name: string): number => room.members.find((m) => m.name === name)!.memberId;
    owner.send({ type: 'adminMute', code: l.code, memberId: idOf('Bad'), minutes: 60 });
    expect((await owner.take('adminAck')).ok).toBe(true);
    // a private window: a fresh clientId with the same name starts muted
    const twin = track(await connected(srv, 'Bad'));
    twin.send({ type: 'joinLobby', code: l.code });
    await twin.take('chatHistory');
    twin.send({ type: 'chat', channel: 'all', text: 'new me' });
    expect((await twin.take('chatNotice')).reason).toBe('muted');
    // a member who was already in from that address chats as before
    mate.send({ type: 'chat', channel: 'all', text: 'still here' });
    await host.take('chat', (m) => m.entry.text === 'still here');
    owner.send({ type: 'adminKick', code: l.code, memberId: idOf('Bad') });
    expect((await owner.take('adminAck')).ok).toBe(true);
    await bad.take('kicked');
    const fresh = track(await connected(srv, 'Bad'));
    fresh.send({ type: 'joinLobby', code: l.code });
    expect(await fresh.take('error')).toMatchObject({ code: 'kicked', message: 'You were removed from this lobby' });
    fresh.send({ type: 'joinLobby', code: l.code, spectate: true });
    expect((await fresh.take('error')).code).toBe('kicked');
    // the owner (same address in this test) may still watch, and the others play on
    owner.send({ type: 'joinLobby', code: l.code, spectate: true });
    await owner.take('chatHistory');
    expect(room.members.some((m) => m.name === 'Mate' && m.session)).toBe(true);
    await sleep(60);
    const seen = (c: Client): string[] => c.inbox.flatMap((m) => (m.type === 'chat' ? [m.entry.text] : []));
    expect(seen(host)).not.toContain('new me');
  });

  it('kick: removed from a running game with a plain note, and refused when coming back', async () => {
    const owner = track(await connected(srv, 'Owner'));
    expect(await owner.auth()).toBe(true);
    const g = await privateGame(srv, ['K1', 'K2', 'K3']);
    track(g.cs);
    const room = srv.hub.rooms.get(g.code)!;
    const k2 = room.members.find((m) => m.name === 'K2')!;
    owner.send({ type: 'adminKick', code: g.code, memberId: k2.memberId });
    expect((await owner.take('adminAck')).ok).toBe(true);
    expect(await g.cs[1].take('kicked')).toEqual({ type: 'kicked', reason: 'You were removed from this game' });
    expect(k2.session).toBeNull();
    expect(room.phase).toBe('running');
    // back by code (as a player or a spectator) and by reconnecting with the same clientId: no way in
    g.cs[1].send({ type: 'joinLobby', code: g.code });
    expect(await g.cs[1].take('error')).toMatchObject({ code: 'kicked', message: 'You were removed from this game' });
    g.cs[1].send({ type: 'joinLobby', code: g.code, spectate: true });
    expect((await g.cs[1].take('error')).code).toBe('kicked');
    const again = await Client.connect(srv.wsUrl);
    track(again);
    again.clientId = g.cs[1].clientId;
    again.send({ type: 'hello', protocol: PROTOCOL_VERSION, name: 'K2', color: [1, 2, 3], clientId: again.clientId, build: 'test' });
    expect((await again.take('welcome')).resumed).toBeNull();
    // the others play on
    await g.cs[0].take('turn');
    // the owner can't remove itself; a lobby member is removed from the lobby
    const l = await privateGame(srv, ['L1', 'L2'], false);
    track(l.cs);
    const lroom = srv.hub.rooms.get(l.code)!;
    owner.send({ type: 'adminKick', code: l.code, memberId: lroom.members[1].memberId });
    expect((await owner.take('adminAck')).ok).toBe(true);
    expect((await l.cs[1].take('kicked')).reason).toBe('You were removed from this game');
    expect(lroom.members.length).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ sim

describe('owner console from a spectator seat (sim, player 0)', () => {
  const twoGames = () => [0, 1].map(() => {
    const s = makeFlatGame(20, 20, 3, { human: true, seed: 5 });
    claimRect(s, 1, 0, 0, 4, 4);
    claimRect(s, 2, 10, 10, 14, 14);
    return s;
  });

  it('applies with an explicit nation, refuses ops that would default to the sender, same hash everywhere', () => {
    const [a, b] = twoGames();
    const acts: Action[] = [
      { type: 'admin', op: 'addResource', player: 2, key: 'gold', amount: 1234 } as Action,
      { type: 'admin', op: 'freezeAI', flag: true } as Action,
    ];
    for (const s of [a, b]) {
      for (const act of acts) expect(applyAction(s, 0, act).ok).toBe(true);
      expect(applyAction(s, 0, { type: 'admin', op: 'addResource', key: 'gold', amount: 1 } as Action)).toEqual({ ok: false, reason: 'Pick a nation' });
      // player 0 sends nothing else
      expect(applyAction(s, 0, { type: 'setAuto', mix: true }).ok).toBe(false);
    }
    expect(a.players[2].gold).toBe(b.players[2].gold);
    expect(a.admin?.aiFrozen).toBe(true);
    expect(hashState(a)).toBe(hashState(b));
    expect(a.players[0].gold).toBe(0);
  });
});
