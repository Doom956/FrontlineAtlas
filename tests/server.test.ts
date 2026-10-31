// Multiplayer relay server: real WebSocket clients against an in-process server on a random port.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGame } from '../src/sim/state';
import {
  DEFAULT_LOBBY_SETTINGS,
  PROTOCOL_VERSION,
  expandCatchUp,
  isHashTurn,
  makeClientId,
  normalizeLobbyCode,
  resolveServerUrl,
} from '../src/net/protocol';
import type { LobbySettings, ServerMessage } from '../src/net/protocol';
import { PUBLIC_NATIONS, publicFill, publicNations } from '../server/hub';
import { assignTeams, resolveColors } from '../server/room';
import { clientIp, startServer } from '../server/server';
import type { IncomingMessage } from 'node:http';
import type { RunningServer } from '../server/server';
import { validateAction, validateClientMessage } from '../server/validate';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

class TestClient {
  readonly inbox: ServerMessage[] = [];
  closeCode: number | null = null;
  clientId = makeClientId();
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => this.inbox.push(JSON.parse(data.toString()) as ServerMessage));
    ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new TestClient(ws);
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** Waits for (and removes) the first message of this type matching pred. */
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

  async hello(name: string, extra: Record<string, unknown> = {}): Promise<Msg<'welcome'>> {
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION, name, color: [10, 20, 30], clientId: this.clientId, build: 'test', ...extra });
    return this.take('welcome');
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const quiet = { log: () => {} };

// ------------------------------------------------------------------------------------------------ pure helpers

describe('protocol helpers', () => {
  it('resolves the server URL: ?server=, build-time, same origin', () => {
    expect(resolveServerUrl({ protocol: 'https:', host: 'game.example', search: '' })).toBe('wss://game.example/ws');
    expect(resolveServerUrl({ protocol: 'http:', host: 'localhost:5173', search: '' })).toBe('ws://localhost:5173/ws');
    expect(resolveServerUrl({ protocol: 'https:', host: 'a.github.io', search: '?server=wss://bf.onrender.com' })).toBe(
      'wss://bf.onrender.com/ws',
    );
    expect(resolveServerUrl({ protocol: 'https:', host: 'a.github.io', search: '?server=bf.fly.dev' })).toBe('wss://bf.fly.dev/ws');
    expect(resolveServerUrl({ protocol: 'https:', host: 'a.github.io', search: '' }, 'https://bf.onrender.com')).toBe(
      'wss://bf.onrender.com/ws',
    );
    expect(resolveServerUrl({ protocol: 'file:', host: '', search: '' })).toBeNull();
  });

  it('normalises codes and expands catch-ups', () => {
    expect(normalizeLobbyCode(' abc-def ')).toBe('ABCDEF');
    expect(normalizeLobbyCode('ABCDE0')).toBeNull(); // 0 is not in the alphabet
    const t = expandCatchUp({ fromTurn: 0, toTurn: 4, turns: [{ n: 2, intents: [{ playerId: 1, action: { type: 'startNow' } }] }] });
    expect(t.map((x) => x.intents.length)).toEqual([0, 0, 1, 0]);
    expect(isHashTurn(9)).toBe(true);
    expect(isHashTurn(10)).toBe(false);
  });

  it('assigns teams evenly, keeping chosen teams', () => {
    expect(assignTeams([0, 0, 0, 0], 0, 2)).toEqual([0, 1, 2, 1, 2]);
    expect(assignTeams([2, 2, 0], 3, 2)).toEqual([0, 2, 2, 1, 1, 1, 2]);
    const t = assignTeams([1], 5, 3);
    expect(t.length).toBe(7);
    expect([1, 2, 3].map((k) => t.filter((x) => x === k).length)).toEqual([2, 2, 2]);
  });

  it('fills public games with AI nations and replaces clashing colours', () => {
    const base: LobbySettings = { ...DEFAULT_LOBBY_SETTINGS, mode: 'ffa', map: { kind: 'generated', type: 'continents', size: 'medium' }, teamCount: 2 };
    expect(publicFill(base, 1).aiCount).toBe(PUBLIC_NATIONS.medium - 1);
    expect(publicFill({ ...base, mode: 'teams', teamCount: 3 }, 2).aiCount % 3).toBe(1);
    const c = resolveColors([
      [10, 10, 10],
      [12, 10, 10],
      [200, 0, 0],
    ]);
    expect(c[0]).toEqual([10, 10, 10]);
    expect(c[1]).not.toEqual([12, 10, 10]);
    expect(c[2]).toEqual([200, 0, 0]);
  });

  it('validates every action type and strips unknown fields', () => {
    const troops = { infantry: 10, armor: 0, artillery: 1 };
    const good: unknown[] = [
      { type: 'spawn', tile: 5 },
      { type: 'attack', tile: 5, troops },
      { type: 'retreat', attackId: 3 },
      { type: 'build', building: 'city', tile: 9 },
      { type: 'demolish', tile: 9 },
      { type: 'setArmyMix', armor: 0.2, artillery: 0.1 },
      { type: 'research', tech: 'agriculture' },
      { type: 'transport', from: 1, to: 2, troops },
      { type: 'buildWarship', port: 4 },
      { type: 'moveWarship', unitId: 4, tile: 8 },
      { type: 'buildAircraft', airfield: 4, kind: 'fighter' },
      { type: 'bomb', airfield: 4, tile: 8 },
      { type: 'launchMissile', silo: 4, kind: 'atomBomb', tile: 8 },
      { type: 'requestAlliance', to: 2 },
      { type: 'answerAlliance', from: 2, accept: true },
      { type: 'breakAlliance', with: 2 },
      { type: 'gift', to: 2, gold: 100, troops: 50 },
      { type: 'toggleEmbargo', with: 2 },
      { type: 'setAuto', mix: false },
      { type: 'startNow' },
    ];
    for (const a of good) {
      const r = validateAction(a);
      expect(r.ok, JSON.stringify(a)).toBe(true);
      if (r.ok) expect(r.value).toEqual(a);
    }
    const stripped = validateAction({ type: 'spawn', tile: 3, evil: '<script>' });
    expect(stripped.ok && stripped.value).toEqual({ type: 'spawn', tile: 3 });
    const bad: unknown[] = [
      null,
      { type: 'spawn' },
      { type: 'spawn', tile: -1 },
      { type: 'spawn', tile: 1.5 },
      { type: 'spawn', tile: '3' },
      { type: 'build', building: 'castle', tile: 1 },
      { type: 'attack', tile: 5, troops: { infantry: 1e300, armor: 0, artillery: 0 } },
      { type: 'attack', tile: 5, troops: { infantry: -1, armor: 0, artillery: 0 } },
      { type: 'setArmyMix', armor: 2, artillery: 0 },
      { type: 'answerAlliance', from: 2, accept: 'yes' },
      { type: 'research', tech: 'toString' },
      { type: 'constructor' },
      { type: '__proto__' },
    ];
    for (const a of bad) expect(validateAction(a).ok, JSON.stringify(a)).toBe(false);
    expect(validateClientMessage({ type: 'hello', protocol: 1, name: 'x'.repeat(40), color: [0, 0, 0], clientId: makeClientId() }).ok).toBe(false);
    expect(validateClientMessage({ type: 'hello', protocol: 1, name: ' Ann\u0000 ', color: [0, 0, 0], clientId: makeClientId() })).toMatchObject({
      ok: true,
      value: { name: 'Ann' },
    });
    expect(validateClientMessage({ type: 'createLobby', settings: { aiCount: 999 } }).ok).toBe(false);
    expect(validateClientMessage({ type: 'createLobby', settings: { hack: 1 } }).ok).toBe(false);
  });

  it('validates the ally requests and setPause (protocol 6)', () => {
    expect(PROTOCOL_VERSION).toBe(9);
    expect(validateAction({ type: 'requestAllyAttack', ally: 3, target: 5, junk: 1 })).toEqual({ ok: true, value: { type: 'requestAllyAttack', ally: 3, target: 5 } });
    expect(validateAction({ type: 'requestAllyAid', ally: 3 })).toEqual({ ok: true, value: { type: 'requestAllyAid', ally: 3 } });
    for (const a of [
      { type: 'requestAllyAttack', ally: 3 },
      { type: 'requestAllyAttack', ally: -1, target: 2 },
      { type: 'requestAllyAttack', ally: 1, target: 1.5 },
      { type: 'requestAllyAttack', ally: '2', target: 4 },
      { type: 'requestAllyAid' },
      { type: 'requestAllyAid', ally: 99999 },
    ]) {
      expect(validateAction(a).ok, JSON.stringify(a)).toBe(false);
    }
    expect(validateClientMessage({ type: 'setPause', paused: true, x: 1 })).toEqual({ ok: true, value: { type: 'setPause', paused: true } });
    expect(validateClientMessage({ type: 'setPause', paused: 'yes' }).ok).toBe(false);
    expect(validateClientMessage({ type: 'setPause' }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ private game

describe('relay server: private lobby game', () => {
  let srv: RunningServer;
  let a: TestClient;
  let b: TestClient;
  let c: TestClient;
  let code = '';
  const opts = { port: 0, host: '127.0.0.1', publicLobbies: false, turnMs: 50, firstTurnDelayMs: 0, sweepMs: 20, hashGraceTurns: 20, ...quiet };

  beforeAll(async () => {
    srv = await startServer(opts);
  });
  afterAll(async () => {
    for (const x of [a, b, c]) await x?.close();
    await srv.close();
  });

  it('serves /health', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it('refuses a wrong protocol version', async () => {
    const x = await TestClient.connect(srv.wsUrl);
    x.send({ type: 'hello', protocol: 999, name: 'Old', color: [1, 2, 3], clientId: x.clientId });
    const e = await x.take('error');
    expect(e.code).toBe('version');
    for (let i = 0; i < 100 && x.closeCode === null; i++) await sleep(10);
    expect(x.closeCode).toBe(4003);
  });

  it('creates a private lobby, joins by code, host starts: identical gameStart for all', async () => {
    [a, b, c] = await Promise.all([TestClient.connect(srv.wsUrl), TestClient.connect(srv.wsUrl), TestClient.connect(srv.wsUrl)]);
    // Before hello nothing else is accepted.
    a.send({ type: 'createLobby' });
    expect((await a.take('error')).code).toBe('notReady');
    await a.hello('Ann');
    await b.hello('Ben');
    await c.hello('Ann'); // same name: made unique
    await a.take('lobbyList');

    a.send({ type: 'createLobby', settings: { map: { kind: 'generated', type: 'pangaea', size: 'small' }, aiCount: 2, maxPlayers: 4, modifiers: { peaceMinutes: 2 } } });
    const ls = await a.take('lobbyState');
    code = ls.code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(ls.isPublic).toBe(false);
    expect(ls.hostMemberId).toBe(ls.you);

    b.send({ type: 'joinLobby', code: code.toLowerCase() });
    await b.take('lobbyState');
    c.send({ type: 'joinLobby', code });
    const cs = await c.take('lobbyState', (m) => m.players.length === 3);
    expect(cs.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Ann 2']);

    c.send({ type: 'joinLobby', code: 'ZZZZZZ' });
    expect((await c.take('error')).code).toBe('notFound');
    b.send({ type: 'startGame' });
    expect((await b.take('error')).code).toBe('notHost');
    b.send({ type: 'updateLobbySettings', settings: { aiCount: 3 } });
    expect((await b.take('error')).code).toBe('notHost');
    a.send({ type: 'updateLobbySettings', settings: { aiCount: 3 } });
    await b.take('lobbyState', (m) => m.settings.aiCount === 3);

    a.send({ type: 'startGame' });
    const starts = await Promise.all([a.take('gameStart'), b.take('gameStart'), c.take('gameStart')]);
    expect(starts.map((s) => s.yourPlayerId)).toEqual([1, 2, 3]);
    const strip = (s: Msg<'gameStart'>): string => JSON.stringify({ ...s, yourPlayerId: 0 });
    expect(strip(starts[1])).toBe(strip(starts[0]));
    expect(strip(starts[2])).toBe(strip(starts[0]));
    const g = starts[0];
    expect(g.code).toBe(code);
    expect(g.startTurn).toBe(0);
    expect(g.turnsPlayed).toBe(0);
    expect(g.teams).toBeNull();
    expect(g.playerSlots.map((p) => p.playerId)).toEqual([1, 2, 3]);
    expect(g.settings).toMatchObject({ map: { kind: 'generated', type: 'pangaea', size: 'small' }, aiCount: 3, humanPlayer: true, playerName: 'Ann' });
    expect(g.settings.modifiers.peaceMinutes).toBe(2);
    expect(g.settings.modifiers.noNukes).toBe(false);
    expect(Number.isInteger(g.settings.seed)).toBe(true);
    // Colours that clash (all three asked for the same one) are replaced.
    expect(new Set(g.playerSlots.map((p) => p.color.join())).size).toBe(3);
    // The settings are a complete GameSettings: the sim can build the game from them.
    const state = createGame(g.settings);
    expect(state.players.filter((p) => p.alive && p.personality !== 'tribe').length).toBeGreaterThanOrEqual(1 + g.settings.aiCount);
    // Lobby actions are refused once started.
    a.send({ type: 'updateLobbySettings', settings: { aiCount: 4 } });
    expect((await a.take('error')).code).toBe('started');
  });

  it('puts intents from two clients into the same turn for everyone, stamped with their player ids', async () => {
    const t0 = await a.take('turn');
    a.send({ type: 'intent', action: { type: 'spawn', tile: 100, extra: 'dropped' } });
    b.send({ type: 'intent', action: { type: 'spawn', tile: 5000 } });
    const find = (x: TestClient) => x.take('turn', (m) => m.n > t0.n && m.intents.length > 0);
    const [ta, tb, tc] = await Promise.all([find(a), find(b), find(c)]);
    expect(ta.n).toBe(tb.n);
    expect(tc.n).toBe(ta.n);
    expect(ta.intents).toEqual([
      { playerId: 1, action: { type: 'spawn', tile: 100 } },
      { playerId: 2, action: { type: 'spawn', tile: 5000 } },
    ]);
    expect(tb).toEqual(ta);
    expect(tc).toEqual(ta);
  });

  it('rejects invalid messages and never relays them', async () => {
    const errors = (): number => c.inbox.filter((m) => m.type === 'error').length;
    c.send('this is not json');
    await c.take('error', (m) => m.code === 'badMessage');
    c.send({ type: 'bogus' });
    await c.take('error', (m) => m.code === 'badMessage');
    c.send({ type: 'intent', action: { type: 'build', building: 'castle', tile: 3 } });
    await c.take('error', (m) => m.code === 'badMessage');
    c.send({ type: 'intent', action: { type: 'spawn', tile: -5 } });
    await c.take('error', (m) => m.code === 'badMessage');
    c.send({ type: 'hash', turn: 1, hash: -3 });
    await c.take('error', (m) => m.code === 'badMessage');
    c.send({ type: 'hello', protocol: PROTOCOL_VERSION, name: 'Again', color: [0, 0, 0], clientId: c.clientId });
    await c.take('error', (m) => m.code === 'notAllowed');
    c.send({ type: 'intent', action: { type: 'startNow' } }); // only the host may
    await c.take('error', (m) => m.code === 'notAllowed');
    expect(errors()).toBe(0);
    // Too many intents in one turn: extras dropped.
    for (let i = 0; i < 15; i++) c.send({ type: 'intent', action: { type: 'setArmyMix', armor: 0.2, artillery: 0.1 } });
    await c.take('error', (m) => m.code === 'rateLimit');
    await sleep(250);
    const all = c.inbox.filter((m): m is Msg<'turn'> => m.type === 'turn');
    const mine = all.flatMap((t) => t.intents.filter((i) => i.playerId === 3));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThanOrEqual(15);
    for (const t of all) {
      expect(t.intents.filter((i) => i.playerId === 3).length).toBeLessThanOrEqual(10);
      for (const i of t.intents) expect(['spawn', 'setArmyMix']).toContain(i.action.type);
    }
    // A frame over the size limit closes the connection.
    const big = await TestClient.connect(srv.wsUrl);
    await big.hello('Big');
    big.send({ type: 'ping', pad: 'x'.repeat(20000) });
    for (let i = 0; i < 100 && big.closeCode === null; i++) await sleep(10);
    expect(big.closeCode).toBe(1009);
  });

  it('sends catchUp (all turns since the start) to a reconnecting player', async () => {
    const oldId = b.clientId;
    await b.close();
    await a.take('presence', (m) => m.players.some((p) => p.playerId === 2 && !p.connected));
    await sleep(150);
    b = await TestClient.connect(srv.wsUrl);
    b.clientId = oldId;
    const w = await b.hello('Ben');
    expect(w.resumed).toBe(code);
    const gs = await b.take('gameStart');
    expect(gs.yourPlayerId).toBe(2);
    expect(gs.turnsPlayed).toBeGreaterThan(0);
    const cu = await b.take('catchUp');
    expect(cu.fromTurn).toBe(0);
    expect(cu.toTurn).toBe(gs.turnsPlayed);
    const turns = expandCatchUp(cu);
    expect(turns.length).toBe(cu.toTurn);
    const spawns = turns.flatMap((t) => t.intents).filter((i) => i.action.type === 'spawn');
    expect(spawns.map((i) => i.playerId)).toEqual([1, 2]);
    const next = await b.take('turn');
    expect(next.n).toBe(cu.toTurn);
    await a.take('presence', (m) => m.players.every((p) => p.connected));
  });

  it('lets a spectator join the running game by code', async () => {
    const s = await TestClient.connect(srv.wsUrl);
    await s.hello('Watcher');
    s.send({ type: 'joinLobby', code });
    const gs = await s.take('gameStart');
    expect(gs.yourPlayerId).toBe(0);
    const cu = await s.take('catchUp');
    expect(cu.toTurn).toBe(gs.turnsPlayed);
    s.send({ type: 'intent', action: { type: 'spawn', tile: 1 } });
    expect((await s.take('error')).code).toBe('notAllowed');
    await s.close();
  });

  it('tells the minority client about a hash mismatch', async () => {
    // Wait until turn 39 has been sent, then report hashes for it.
    await a.take('turn', (m) => m.n >= 39, 6000);
    a.send({ type: 'hash', turn: 39, hash: 111 });
    b.send({ type: 'hash', turn: 39, hash: 111 });
    c.send({ type: 'hash', turn: 39, hash: 222 });
    const d = await c.take('desync');
    expect(d).toMatchObject({ turn: 39, yourHash: 222, majorityHash: 111, agreeing: 2, total: 3 });
    await sleep(100);
    expect(a.has('desync')).toBe(false);
    expect(b.has('desync')).toBe(false);
    // Matching hashes: nothing.
    await a.take('turn', (m) => m.n >= 49, 3000);
    a.send({ type: 'hash', turn: 49, hash: 5 });
    b.send({ type: 'hash', turn: 49, hash: 5 });
    await sleep(100);
    expect(a.has('desync') || b.has('desync')).toBe(false);
    // Not a hash turn.
    a.send({ type: 'hash', turn: 40, hash: 5 });
    expect((await a.take('error')).code).toBe('badMessage');
  });

  it('ends the game when the majority reports game over', async () => {
    const last = await a.take('turn');
    a.send({ type: 'gameOver', turn: last.n, winner: 1 });
    await sleep(50);
    expect(a.has('gameOver')).toBe(false);
    b.send({ type: 'gameOver', turn: last.n, winner: 1 });
    const over = await Promise.all([a.take('gameOver'), b.take('gameOver'), c.take('gameOver')]);
    for (const o of over) expect(o).toMatchObject({ reason: 'finished', winner: 1 });
    a.inbox.length = 0;
    await sleep(200);
    expect(a.has('turn')).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ lobby controls

describe('relay server: lobby controls', () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', publicLobbies: false, sweepMs: 20, lobbyReconnectGraceMs: 100, ...quiet });
  });
  afterAll(async () => {
    await srv.close();
  });

  it('kick, team choice, host hand-over and lobby close', async () => {
    const [h, p, q] = await Promise.all([TestClient.connect(srv.wsUrl), TestClient.connect(srv.wsUrl), TestClient.connect(srv.wsUrl)]);
    await h.hello('Host');
    await p.hello('P');
    await q.hello('Q');
    h.send({ type: 'createLobby', settings: { mode: 'teams', teamCount: 3 } });
    const { code } = await h.take('lobbyState');
    p.send({ type: 'joinLobby', code });
    q.send({ type: 'joinLobby', code });
    const st = await h.take('lobbyState', (m) => m.players.length === 3);
    const qId = st.players.find((x) => x.name === 'Q')!.memberId;

    p.send({ type: 'setTeam', team: 3 });
    await h.take('lobbyState', (m) => m.players.some((x) => x.name === 'P' && x.team === 3));
    p.send({ type: 'setTeam', team: 4 });
    expect((await p.take('error')).code).toBe('badMessage');

    h.send({ type: 'kick', memberId: qId });
    expect((await q.take('kicked')).reason).toMatch(/removed/);
    await q.take('lobbyList');
    q.send({ type: 'joinLobby', code });
    expect((await q.take('error')).code).toBe('kicked');

    // Host leaves: P becomes host.
    h.send({ type: 'leaveLobby' });
    const after = await p.take('lobbyState', (m) => m.players.length === 1);
    expect(after.hostMemberId).toBe(after.you);
    // Different client build can't join.
    const other = await TestClient.connect(srv.wsUrl);
    await other.hello('Other', { build: 'another-build' });
    other.send({ type: 'joinLobby', code });
    expect((await other.take('error')).code).toBe('version');
    // Last player disconnects: after the grace period the lobby is gone.
    await p.close();
    await sleep(300);
    h.send({ type: 'joinLobby', code });
    expect((await h.take('error')).code).toBe('notFound');
    for (const x of [h, q, other]) await x.close();
  });

  it('limits connections per address', async () => {
    const s2 = await startServer({ port: 0, host: '127.0.0.1', publicLobbies: false, maxConnectionsPerIp: 2, ...quiet });
    const x = await TestClient.connect(s2.wsUrl);
    const y = await TestClient.connect(s2.wsUrl);
    await expect(TestClient.connect(s2.wsUrl)).rejects.toThrow(/429/);
    await x.close();
    await y.close();
    await s2.close();
  });
});

// ------------------------------------------------------------------------------------------------ public lobbies

describe('relay server: public lobbies', () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', publicStartMs: 300, firstTurnDelayMs: 0, sweepMs: 20, ...quiet });
  });
  afterAll(async () => {
    await srv.close();
  });

  it('keeps an FFA and a Teams lobby open and starts them after the countdown', async () => {
    const x = await TestClient.connect(srv.wsUrl);
    await x.hello('Solo');
    const list = await x.take('lobbyList');
    expect(list.lobbies.map((l) => l.kind).sort()).toEqual(['ffa', 'special', 'teams']);
    const ffa = list.lobbies.find((l) => l.kind === 'ffa')!;
    expect(ffa.startsAt).toBeNull();
    expect(ffa.chips).toEqual([]);
    // Special: free-for-all with 1-3 random modifiers, listed as chips
    const special = list.lobbies.find((l) => l.kind === 'special')!;
    expect(special.mode).toBe('ffa');
    expect(special.chips.length).toBeGreaterThanOrEqual(1);
    expect(special.chips.length).toBeLessThanOrEqual(3);
    expect(special.rules).toBe(special.chips.map((c) => c.label).join(', '));

    x.send({ type: 'joinLobby', code: ffa.code });
    const ls = await x.take('lobbyState');
    expect(ls.isPublic).toBe(true);
    expect(ls.hostMemberId).toBe(-1);
    expect(ls.startsAt).not.toBeNull();
    expect((ls.startsAt as number) - ls.serverTime).toBeGreaterThan(200);
    expect((ls.startsAt as number) - ls.serverTime).toBeLessThanOrEqual(300);
    x.send({ type: 'startGame' });
    expect((await x.take('error')).code).toBe('notAllowed');

    const gs = await x.take('gameStart', () => true, 2000);
    expect(gs.yourPlayerId).toBe(1);
    expect(gs.playerSlots.length).toBe(1);
    expect(gs.settings.aiCount).toBe(Math.min(15, publicNations(gs.settings) - 1));
    expect(gs.settings.humans).toEqual([{ name: 'Solo', color: gs.playerSlots[0].color, team: 0 }]);
    await x.take('turn');

    // A new FFA lobby replaced the started one.
    const y = await TestClient.connect(srv.wsUrl);
    await y.hello('Next');
    const list2 = await y.take('lobbyList');
    const ffa2 = list2.lobbies.find((l) => l.kind === 'ffa')!;
    expect(ffa2.code).not.toBe(ffa.code);
    expect(JSON.stringify(ffa2.map)).not.toBe(JSON.stringify(ffa.map));

    // Teams lobby: two humans on auto end up on different teams; AI nations fill the teams evenly.
    const teams = list2.lobbies.find((l) => l.kind === 'teams')!;
    const z = await TestClient.connect(srv.wsUrl);
    await z.hello('Zed');
    y.send({ type: 'joinLobby', code: teams.code });
    z.send({ type: 'joinLobby', code: teams.code });
    const [gy, gz] = await Promise.all([y.take('gameStart', () => true, 2000), z.take('gameStart', () => true, 2000)]);
    expect(gy.teams).toEqual(gz.teams);
    const t = gy.teams!;
    expect(t.count).toBe(teams.teamCount);
    expect(t.byPlayer.length).toBe(1 + 2 + gy.settings.aiCount);
    expect(t.byPlayer[1]).not.toBe(t.byPlayer[2]);
    expect(gy.playerSlots.map((p) => p.team)).toEqual([t.byPlayer[1], t.byPlayer[2]]);
    expect(gy.settings.humans!.map((h) => h.team)).toEqual([t.byPlayer[1], t.byPlayer[2]]);
    const sizes = Array.from({ length: t.count }, (_, k) => t.byPlayer.filter((v) => v === k + 1).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    for (const c of [x, y, z]) await c.close();
  });
});

// ------------------------------------------------------------------------------------------------ abuse and long games

describe('relay server: long games, limits and votes', () => {
  let srv: RunningServer;
  const base = { port: 0, host: '127.0.0.1', publicLobbies: false, turnMs: 50, firstTurnDelayMs: 0, sweepMs: 20, createLobbyCooldownMs: 0, ...quiet };
  beforeAll(async () => {
    srv = await startServer({ ...base, maxRoomsPerIp: 50 });
  });
  afterAll(async () => {
    await srv.close();
  });

  /** n clients in a started private game; returns them and the code. */
  async function game(names: string[]): Promise<{ cs: TestClient[]; code: string }> {
    const cs = await Promise.all(names.map(() => TestClient.connect(srv.wsUrl)));
    for (let i = 0; i < cs.length; i++) await cs[i].hello(names[i]);
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

  it('sends a long history in drained chunks, and only the gap to a client that says what it has', async () => {
    const { cs, code } = await game(['Long']);
    const [a] = cs;
    const room = srv.hub.rooms.get(code)!;
    const id = a.clientId;
    await a.close();
    // Synthetic history: 20000 turns with 3 intents each (~4 MB serialized), more than 8 chunks.
    const r = room as unknown as { pending: unknown[] };
    for (let k = 0; k < 20000; k++) {
      for (let j = 0; j < 3; j++) r.pending.push({ playerId: 1, action: { type: 'setArmyMix', armor: 0.125, artillery: 0.25 } });
      room.endTurn();
    }
    const b = await TestClient.connect(srv.wsUrl);
    b.clientId = id;
    expect((await b.hello('Long')).resumed).toBe(code);
    const gs = await b.take('gameStart');
    const chunks: Msg<'catchUp'>[] = [];
    let next = 0;
    while (next < gs.turnsPlayed) {
      const cu = await b.take('catchUp', () => true, 5000);
      expect(cu.fromTurn).toBe(next);
      expect(JSON.stringify(cu).length).toBeLessThan(700 * 1024);
      chunks.push(cu);
      next = cu.toTurn;
    }
    expect(chunks.length).toBeGreaterThan(4);
    const all = chunks.flatMap((c) => expandCatchUp(c));
    expect(all.length).toBe(next);
    expect(all.filter((t) => t.intents.length === 3).length).toBeGreaterThanOrEqual(20000);
    // Live turns only after the catch-up, in order (the synthetic turns put the room's clock ahead: end one by hand).
    expect(b.has('turn')).toBe(false);
    room.endTurn();
    const live = await b.take('turn');
    expect(live.n).toBe(next);
    await b.close();

    // A reconnect that says which turns it holds gets only the rest.
    const c = await TestClient.connect(srv.wsUrl);
    c.clientId = id;
    await c.hello('Long', { resume: { code, haveTurns: next - 5 } });
    const gs2 = await c.take('gameStart');
    const cu2 = await c.take('catchUp');
    expect(cu2.fromTurn).toBe(next - 5);
    expect(cu2.toTurn).toBe(gs2.turnsPlayed);
    // joinLobby for the game you are in: no second gameStart / catch-up.
    c.inbox.length = 0;
    c.send({ type: 'joinLobby', code });
    await sleep(200);
    expect(c.has('gameStart') || c.has('catchUp')).toBe(false);
    await c.close();
  });

  it('a reconnect puts you in your current lobby, not in a game you left', async () => {
    const { cs, code } = await game(['Al', 'Bo']);
    const [a, b] = cs;
    a.send({ type: 'leaveLobby' });
    await a.take('lobbyList');
    a.send({ type: 'createLobby' });
    const ls = await a.take('lobbyState', (m) => m.code !== code);
    const id = a.clientId;
    await a.close();
    const a2 = await TestClient.connect(srv.wsUrl);
    a2.clientId = id;
    expect((await a2.hello('Al')).resumed).toBe(ls.code);
    await a2.take('lobbyState');
    expect(a2.has('gameStart')).toBe(false);
    // The left seat can still be taken back by code.
    a2.send({ type: 'joinLobby', code });
    expect((await a2.take('gameStart')).yourPlayerId).toBe(1);
    for (const x of [a2, b]) await x.close();
  });

  it('one player cannot end a multi-human game alone, and the winner must exist', async () => {
    const { cs } = await game(['P1', 'P2', 'P3']);
    const [a, b, c] = cs;
    const t = await a.take('turn');
    a.send({ type: 'gameOver', turn: t.n, winner: 999 });
    expect((await a.take('error')).code).toBe('badMessage');
    await b.close();
    await c.close();
    await sleep(50);
    a.send({ type: 'gameOver', turn: t.n, winner: 1 });
    await sleep(150);
    expect(a.has('gameOver')).toBe(false);
    await a.close();
  });

  it('2 players with different hashes: a soft notice, and a spectator breaks the tie', async () => {
    const { cs, code } = await game(['H1', 'H2']);
    const [a, b] = cs;
    await a.take('turn', (m) => m.n >= 9, 3000);
    a.send({ type: 'hash', turn: 9, hash: 1 });
    b.send({ type: 'hash', turn: 9, hash: 2 });
    const [da, db] = await Promise.all([a.take('desync'), b.take('desync')]);
    expect(da.majorityHash).toBeNull();
    expect(db.majorityHash).toBeNull();
    // Still checked afterwards: a spectator in sync decides who is out.
    const s = await TestClient.connect(srv.wsUrl);
    await s.hello('Spec');
    s.send({ type: 'joinLobby', code, spectate: true });
    await s.take('gameStart');
    await a.take('turn', (m) => m.n >= 29, 3000);
    a.send({ type: 'hash', turn: 29, hash: 7 });
    b.send({ type: 'hash', turn: 29, hash: 8 });
    s.send({ type: 'hash', turn: 29, hash: 7 });
    const d = await b.take('desync');
    expect(d).toMatchObject({ turn: 29, majorityHash: 7, agreeing: 2, total: 3 });
    await sleep(100);
    expect(a.has('desync')).toBe(false);
    for (const x of [a, b, s]) await x.close();
  });
});

describe('relay server: per-address limits', () => {
  it('caps live rooms per address; leaving a solo game ends it at once', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', publicLobbies: false, sweepMs: 20, maxRoomsPerIp: 2, createLobbyCooldownMs: 0, ...quiet });
    const cs = await Promise.all([0, 1, 2].map(() => TestClient.connect(srv.wsUrl)));
    for (const c of cs) await c.hello('X');
    const codes: string[] = [];
    for (const c of cs.slice(0, 2)) {
      c.send({ type: 'createLobby' });
      codes.push((await c.take('lobbyState')).code);
      c.send({ type: 'startGame' });
      await c.take('gameStart');
    }
    cs[2].send({ type: 'createLobby' });
    expect((await cs[2].take('error')).code).toBe('rateLimit');
    cs[0].send({ type: 'leaveLobby' });
    await sleep(50);
    expect(srv.hub.rooms.has(codes[0])).toBe(false);
    cs[2].send({ type: 'createLobby' });
    await cs[2].take('lobbyState');
    for (const c of cs) await c.close();
    await srv.close();
  });

  it('createLobby cooldown and a steady intent budget', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', publicLobbies: false, turnMs: 50, firstTurnDelayMs: 0, sweepMs: 20, createLobbyCooldownMs: 500, intentsPerSecond: 1, intentBurst: 3, ...quiet });
    const a = await TestClient.connect(srv.wsUrl);
    await a.hello('A');
    a.send({ type: 'createLobby' });
    await a.take('lobbyState');
    a.send({ type: 'createLobby' });
    expect((await a.take('error')).code).toBe('rateLimit');
    a.send({ type: 'startGame' });
    await a.take('gameStart');
    for (let i = 0; i < 6; i++) {
      a.send({ type: 'intent', action: { type: 'setArmyMix', armor: 0.1, artillery: 0.1 } });
      await sleep(60);
    }
    expect((await a.take('error')).message).toMatch(/slow down/);
    await sleep(100);
    const mine = a.inbox.filter((m): m is Msg<'turn'> => m.type === 'turn').flatMap((t) => t.intents);
    expect(mine.length).toBe(3);
    await a.close();
    await srv.close();
  });

  it('takes the client address from the end of X-Forwarded-For (the first entries are the client\'s own)', () => {
    const req = (headers: Record<string, string>): IncomingMessage => ({ headers, socket: { remoteAddress: '10.9.9.9' } }) as unknown as IncomingMessage;
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' }), true)).toBe('1.2.3.4');
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 172.16.0.1' }), true, 2)).toBe('1.2.3.4');
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6', 'fly-client-ip': '5.5.5.5' }), true, 1, 'fly-client-ip')).toBe('5.5.5.5');
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6' }), false)).toBe('10.9.9.9');
  });
});

// ------------------------------------------------------------------------------------------------ pause

describe('relay server: host pause', () => {
  let srv: RunningServer;
  const base = {
    port: 0,
    host: '127.0.0.1',
    publicLobbies: false,
    turnMs: 40,
    firstTurnDelayMs: 0,
    sweepMs: 20,
    createLobbyCooldownMs: 0,
    pauseToggleMs: 100,
    pauseHostGoneMs: 400,
    ...quiet,
  };
  beforeAll(async () => {
    srv = await startServer({ ...base, maxRoomsPerIp: 50 });
  });
  afterAll(async () => {
    await srv.close();
  });

  async function game(names: string[]): Promise<{ cs: TestClient[]; code: string }> {
    const cs = await Promise.all(names.map(() => TestClient.connect(srv.wsUrl)));
    for (let i = 0; i < cs.length; i++) await cs[i].hello(names[i]);
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
  const lastTurn = (c: TestClient): number => Math.max(-1, ...c.inbox.filter((m) => m.type === 'turn').map((m) => (m as Msg<'turn'>).n));

  it('host pauses and resumes for everyone (spectators too); no turns while paused; others are refused', async () => {
    const { cs, code } = await game(['Host', 'Guest']);
    const [h, g] = cs;
    const spec = await TestClient.connect(srv.wsUrl);
    await spec.hello('Watcher');
    spec.send({ type: 'joinLobby', code, spectate: true });
    await spec.take('gameStart');
    await h.take('turn', (m) => m.n >= 3);
    // A guest can't pause; neither before nor after the host does.
    g.send({ type: 'setPause', paused: true });
    expect((await g.take('error')).code).toBe('notHost');
    h.send({ type: 'setPause', paused: true });
    const ps = await Promise.all([h.take('pauseState'), g.take('pauseState'), spec.take('pauseState')]);
    for (const p of ps) expect(p).toEqual({ type: 'pauseState', paused: true, by: 1, host: 1 });
    // Turns stop: wait for the last one in flight, then nothing more arrives.
    await sleep(60);
    const frozen = lastTurn(g);
    await sleep(300);
    expect(lastTurn(g)).toBe(frozen);
    expect(lastTurn(spec)).toBe(frozen);
    // Intents are refused while paused.
    g.send({ type: 'intent', action: { type: 'setAuto', mix: true } });
    expect((await g.take('error', (e) => e.code === 'notAllowed')).message).toMatch(/paused/);
    g.send({ type: 'setPause', paused: false });
    expect((await g.take('error')).code).toBe('notHost');
    // Toggling too fast is rate-limited.
    await sleep(120);
    h.send({ type: 'setPause', paused: false });
    await Promise.all([h.take('pauseState', (m) => !m.paused), g.take('pauseState', (m) => !m.paused), spec.take('pauseState', (m) => !m.paused)]);
    h.send({ type: 'setPause', paused: true });
    expect((await h.take('error')).code).toBe('rateLimit');
    // Turns continue in order from where they stopped (no burst, no gap).
    const next = await g.take('turn', (m) => m.n > frozen);
    expect(next.n).toBe(frozen + 1);
    for (const c of [...cs, spec]) await c.close();
  });

  it('a player reconnecting to a paused game gets the pause state after gameStart', async () => {
    const { cs } = await game(['Host', 'Guest']);
    const [h, g] = cs;
    await h.take('turn', (m) => m.n >= 2);
    h.send({ type: 'setPause', paused: true });
    await g.take('pauseState');
    const oldId = g.clientId;
    await g.close();
    const g2 = await TestClient.connect(srv.wsUrl);
    g2.clientId = oldId;
    await g2.hello('Guest');
    const gs = await g2.take('gameStart');
    expect(gs.yourPlayerId).toBe(2);
    const p = await g2.take('pauseState');
    expect(p).toMatchObject({ paused: true, by: 1, host: 1 });
    await sleep(150);
    expect(g2.has('turn')).toBe(false);
    for (const c of [h, g2]) await c.close();
  });

  it('when the paused host stays away, the game resumes on its own and the host role passes on', async () => {
    const { cs } = await game(['Host', 'Guest']);
    const [h, g] = cs;
    await h.take('turn', (m) => m.n >= 2);
    h.send({ type: 'setPause', paused: true });
    await g.take('pauseState', (m) => m.paused);
    await h.close();
    await sleep(150);
    expect(g.inbox.some((m) => m.type === 'pauseState' && !(m as Msg<'pauseState'>).paused)).toBe(false);
    const resumed = await g.take('pauseState', (m) => !m.paused, 3000);
    expect(resumed).toEqual({ type: 'pauseState', paused: false, by: 0, host: 2 });
    await g.take('turn');
    // The guest is the host now: it may pause.
    await sleep(120);
    g.send({ type: 'setPause', paused: true });
    expect(await g.take('pauseState', (m) => m.paused)).toMatchObject({ by: 2, host: 2 });
    await g.close();
  });

  it('public games cannot be paused', async () => {
    const pub = await startServer({ ...base, publicLobbies: true, publicStartMs: 50 });
    try {
      const c = await TestClient.connect(pub.wsUrl);
      await c.hello('Solo');
      const list = await c.take('lobbyList', (m) => m.lobbies.length > 0);
      c.send({ type: 'joinLobby', code: list.lobbies[0].code });
      await c.take('gameStart', () => true, 5000);
      c.send({ type: 'setPause', paused: true });
      expect((await c.take('error')).code).toBe('notAllowed');
      await c.close();
    } finally {
      await pub.close();
    }
  });
});
