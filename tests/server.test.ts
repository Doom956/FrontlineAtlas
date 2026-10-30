// Multiplayer relay server: real WebSocket clients against an in-process server on a random port.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createGame } from '../src/sim/state';
import {
  PROTOCOL_VERSION,
  expandCatchUp,
  isHashTurn,
  makeClientId,
  normalizeLobbyCode,
  resolveServerUrl,
} from '../src/net/protocol';
import type { LobbySettings, ServerMessage } from '../src/net/protocol';
import { PUBLIC_NATIONS, publicFill } from '../server/hub';
import { assignTeams, resolveColors } from '../server/room';
import { startServer } from '../server/server';
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
    const base = { mode: 'ffa', mapSize: 'medium', teamCount: 2 } as LobbySettings;
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

    a.send({ type: 'createLobby', settings: { mapSize: 'small', mapType: 'pangaea', aiCount: 2, maxPlayers: 4 } });
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
    expect(g.settings).toMatchObject({ mapType: 'pangaea', mapSize: 'small', aiCount: 3, humanPlayer: true, playerName: 'Ann' });
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
    expect(list.lobbies.map((l) => l.mode).sort()).toEqual(['ffa', 'teams']);
    const ffa = list.lobbies.find((l) => l.mode === 'ffa')!;
    expect(ffa.startsAt).toBeNull();

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
    expect(gs.settings.aiCount).toBe(Math.min(15, PUBLIC_NATIONS[gs.settings.mapSize] - 1));
    await x.take('turn');

    // A new FFA lobby replaced the started one.
    const y = await TestClient.connect(srv.wsUrl);
    await y.hello('Next');
    const list2 = await y.take('lobbyList');
    const ffa2 = list2.lobbies.find((l) => l.mode === 'ffa')!;
    expect(ffa2.code).not.toBe(ffa.code);
    expect(`${ffa2.mapType}/${ffa2.mapSize}`).not.toBe(`${ffa.mapType}/${ffa.mapSize}`);

    // Teams lobby: two humans on auto end up on different teams; AI nations fill the teams evenly.
    const teams = list2.lobbies.find((l) => l.mode === 'teams')!;
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
    const sizes = Array.from({ length: t.count }, (_, k) => t.byPlayer.filter((v) => v === k + 1).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    for (const c of [x, y, z]) await c.close();
  });
});
