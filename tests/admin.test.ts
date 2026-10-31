// Owner console (src/sim/admin.ts, server/admin.ts) and continuing a finished game (victory.continueGame, room.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { applyAction } from '../src/sim/actions';
import { ADMIN_OP_LIST, ADMIN_OPS, validateAdmin } from '../src/sim/admin';
import { buildingAt, hasIntel, markBuildingsChanged } from '../src/sim/buildings';
import { TECHS, TICKS_PER_SECOND } from '../src/sim/config';
import { areAllied } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { peaceActive } from '../src/sim/rules';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { Terrain } from '../src/sim/types';
import type { Action, AdminAction, Building, GameState } from '../src/sim/types';
import { makeClientId, PROTOCOL_VERSION } from '../src/net/protocol';
import type { ServerMessage } from '../src/net/protocol';
import { AdminGate, ADMIN_MAX_FAILS } from '../server/admin';
import { ADMIN_CHECK_MAX_BYTES, ADMIN_CHECK_PATH, PAGES_ORIGIN, startServer } from '../server/server';
import type { RunningServer } from '../server/server';
import { validateAction, validateClientMessage } from '../server/validate';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
const admin = (s: GameState, a: Omit<AdminAction, 'type'>, by = 1) => applyAction(s, by, { type: 'admin', ...a } as Action);

/** 60x30 plains, player 1 human (x 0..19), 2 and 3 AIs (x 20..39, 40..59). */
function game(seed = 4): GameState {
  const s = makeFlatGame(60, 30, 3, { human: true, seed });
  claimRect(s, 1, 0, 0, 19, 29);
  claimRect(s, 2, 20, 0, 39, 29);
  claimRect(s, 3, 40, 0, 59, 29);
  s.settings.victoryLandShare = 0.95;
  return s;
}
function factory(s: GameState, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type: 'factory', owner, tile, level: 1, buildLeft: 30, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

describe('owner console: validation', () => {
  it('lists every op, and checks fields, sender and phase', () => {
    const s = game();
    expect(ADMIN_OP_LIST.length).toBe(Object.keys(ADMIN_OPS).length);
    expect(validateAdmin(s, { type: 'admin', op: 'nope' as never })).toMatch(/Unknown/);
    expect(validateAdmin(s, { type: 'admin', op: 'setResource', amount: 5 })).toMatch(/Missing key/);
    expect(validateAdmin(s, { type: 'admin', op: 'setResource', key: 'gold' })).toMatch(/Missing amount/);
    expect(validateAdmin(s, { type: 'admin', op: 'setResource', key: 'gold', amount: Infinity })).toMatch(/Invalid amount/);
    expect(validateAdmin(s, { type: 'admin', op: 'paintTiles', tile: -1 })).toMatch(/Invalid tile/);
    expect(validateAdmin(s, { type: 'admin', op: 'forceAlliance', other: 99 })).toMatch(/Invalid other/);
    expect(validateAdmin(s, { type: 'admin', op: 'freezeAI', flag: 1 as never })).toMatch(/Invalid flag/);
    // every op refuses an empty call when it needs a field
    for (const op of ADMIN_OP_LIST) {
      const required = ADMIN_OPS[op].filter((f) => !f.endsWith('?'));
      const r = validateAdmin(s, { type: 'admin', op });
      if (required.length) expect(r).toMatch(/Missing/);
      else expect(r).toBeNull();
    }
    expect(admin(s, { op: 'setResource', key: 'gold', amount: 5 }, 2).ok).toBe(false); // an AI
    expect(admin(s, { op: 'setResource', key: 'copper', amount: 5 }).reason).toMatch(/gold, iron/);
    s.phase = 'spawn';
    expect(admin(s, { op: 'setResource', key: 'gold', amount: 5 }).ok).toBe(false);
  });
});

describe('owner console: operations', () => {
  it('resources, troops, research', () => {
    const s = game();
    expect(admin(s, { op: 'setResource', key: 'gold', amount: 12345 }).ok).toBe(true);
    expect(s.players[1].gold).toBe(12345);
    admin(s, { op: 'addResource', player: 2, key: 'oil', amount: -1e9 });
    expect(s.players[2].oil).toBe(0);
    admin(s, { op: 'addResource', player: 3, key: 'science', amount: 50 });
    expect(s.players[3].science).toBe(50);
    admin(s, { op: 'setTroops', player: 2, troops: { infantry: 10, armor: 20, artillery: 30 } });
    expect(s.players[2].troops).toEqual({ infantry: 10, armor: 20, artillery: 30 });
    admin(s, { op: 'addTroops', player: 2, amount: 5 });
    expect(s.players[2].troops.infantry).toBe(15);
    s.players[2].maxPop = 1000;
    admin(s, { op: 'fillTroops', player: 2 });
    expect(s.players[2].troops.infantry + 20 + 30).toBe(1000);
    admin(s, { op: 'unlockAllTechs' });
    expect(s.players[1].techs.length).toBe(Object.keys(TECHS).length);
    admin(s, { op: 'removeTech', key: 'flight' });
    expect(s.players[1].techs).not.toContain('flight');
    admin(s, { op: 'unlockTech', key: 'flight' });
    expect(s.players[1].techs).toContain('flight');
    s.players[2].researching = 'banking';
    admin(s, { op: 'finishResearch', player: 2 });
    expect(s.players[2].techs).toContain('banking');
    expect(s.players[2].researching).toBeNull();
    expect(admin(s, { op: 'unlockTech', key: 'warpDrive' }).ok).toBe(false);
  });

  it('buildings and units', () => {
    const s = game();
    const f = factory(s, 1, at(s, 5, 5));
    admin(s, { op: 'finishConstructions' });
    expect(f.buildLeft).toBe(0);
    expect(admin(s, { op: 'placeBuilding', player: 2, key: 'city', tile: at(s, 30, 10), amount: 4 }).ok).toBe(true);
    const c = buildingAt(s, at(s, 30, 10))!;
    expect(c.type).toBe('city');
    expect(c.level).toBe(4);
    expect(c.owner).toBe(2);
    expect(c.buildLeft).toBe(0);
    admin(s, { op: 'setBuildingLevel', tile: c.tile, amount: 2 });
    expect(c.level).toBe(2);
    admin(s, { op: 'deleteBuilding', tile: c.tile });
    expect(buildingAt(s, c.tile)).toBeUndefined();
    admin(s, { op: 'placeBuilding', key: 'airfield', tile: at(s, 8, 8) });
    admin(s, { op: 'giveAircraft', tile: at(s, 8, 8), key: 'bomber', amount: 3 });
    expect(buildingAt(s, at(s, 8, 8))!.bombers).toBe(3);
    // placing on someone else's land takes the tile for the owner
    admin(s, { op: 'placeBuilding', key: 'fort', tile: at(s, 45, 5) });
    expect(s.map.owner[at(s, 45, 5)]).toBe(1);
    expect(admin(s, { op: 'spawnTankDivision', tile: at(s, 6, 6) }).ok).toBe(true);
    expect(s.units.some((u) => u.type === 'tankDivision' && u.owner === 1)).toBe(true);
    expect(admin(s, { op: 'spawnWarship', tile: at(s, 6, 6) }).reason).toMatch(/water/);
    s.map.terrain[at(s, 2, 2)] = Terrain.DeepWater;
    expect(admin(s, { op: 'spawnWarship', tile: at(s, 2, 2) }).ok).toBe(true);
  });

  it('territory, capital, diplomacy, doctrine', () => {
    const s = game();
    admin(s, { op: 'paintTiles', player: 1, tile: at(s, 30, 15), amount: 3 });
    expect(s.map.owner[at(s, 30, 15)]).toBe(1);
    expect(s.map.owner[at(s, 33, 15)]).toBe(1);
    admin(s, { op: 'neutralizeTiles', tile: at(s, 50, 15), amount: 2 });
    expect(s.map.owner[at(s, 50, 15)]).toBe(0);
    expect(admin(s, { op: 'moveCapital', tile: at(s, 50, 1) }).ok).toBe(false);
    admin(s, { op: 'moveCapital', tile: at(s, 3, 3) });
    expect(s.players[1].capital).toBe(at(s, 3, 3));
    admin(s, { op: 'forceAlliance', player: 2, other: 3 });
    expect(areAllied(s, 2, 3)).toBe(true);
    admin(s, { op: 'breakAlliance', player: 2, other: 3 });
    expect(areAllied(s, 2, 3)).toBe(false);
    expect(s.players[2].traitorUntil).toBe(0); // no penalty from the console
    admin(s, { op: 'setOpinion', player: 2, other: 1, amount: 500 });
    expect(s.opinion[2][1]).toBe(100);
    s.players[2].troops = { infantry: 30000, armor: 0, artillery: 0 };
    admin(s, { op: 'declareWar', player: 2, other: 3 });
    expect(s.attacks.some((a) => a.attacker === 2 && a.target === 3)).toBe(true);
    expect(s.opinion[2][3]).toBe(-100);
    admin(s, { op: 'setDoctrine', player: 3, key: 'siege', amount: 3 });
    expect(s.players[3].doctrine.id).toBe('siege');
    expect(s.players[3].doctrine.level).toBe(3);
    tick(s);
    expect(s.players[3].doctrine.level).toBe(3);
  });

  it('eliminate and revive; peace time; intel', () => {
    const s = game();
    expect(admin(s, { op: 'eliminate', player: 3 }).ok).toBe(true);
    expect(s.players[3].alive).toBe(false);
    expect(admin(s, { op: 'eliminate', player: 1 }).ok).toBe(false); // not yourself
    expect(admin(s, { op: 'revive', player: 3, tile: at(s, 50, 15), amount: 5000 }).ok).toBe(true);
    expect(s.players[3].alive).toBe(true);
    expect(s.players[3].troops.infantry).toBe(5000);
    expect(s.map.owner[at(s, 50, 15)]).toBe(3);
    expect(s.players[3].capital).toBe(at(s, 50, 15));
    const original = s.settings;
    admin(s, { op: 'setPeace', amount: 120 });
    expect(peaceActive(s)).toBe(true);
    expect(original.modifiers.peaceMinutes).toBe(0); // the caller's settings object is untouched
    admin(s, { op: 'setPeace', amount: 0 });
    expect(peaceActive(s)).toBe(false);
    expect(hasIntel(s, 1, 3)).toBe(false);
    admin(s, { op: 'revealIntel', flag: true });
    expect(hasIntel(s, 1, 3)).toBe(true);
    expect(hasIntel(s, 2, 3)).toBe(false);
    admin(s, { op: 'setDifficulty', key: 'brutal' });
    expect(s.settings.difficulty).toBe('brutal');
    expect(admin(s, { op: 'setDifficulty', key: 'insane' }).ok).toBe(false);
  });

  it('AI passive, frozen AI and god mode', () => {
    const s = game();
    s.players[2].troops = { infantry: 30000, armor: 0, artillery: 0 };
    admin(s, { op: 'aiPassive', flag: true });
    const atk: Action = { type: 'attack', tile: at(s, 19, 10), troops: { infantry: 5000, armor: 0, artillery: 0 } };
    expect(applyAction(s, 2, atk).reason).toMatch(/off limits/);
    expect(applyAction(s, 2, { ...atk, tile: at(s, 40, 10) } as Action).ok).toBe(true); // others are fair game
    admin(s, { op: 'aiPassive', flag: false });
    admin(s, { op: 'freezeAI', flag: true });
    expect(applyAction(s, 2, atk).reason).toMatch(/frozen/);
    admin(s, { op: 'freezeAI', flag: false });
    // God mode: an attack on player 1 ends at once and its troops go home.
    admin(s, { op: 'godMode', flag: true });
    expect(applyAction(s, 2, atk).ok).toBe(true);
    const tiles = s.players[1].tiles;
    for (let k = 0; k < 30; k++) tick(s);
    expect(s.players[1].tiles).toBe(tiles);
    expect(s.attacks.some((a) => a.attacker === 2 && a.target === 1)).toBe(false);
  });

  it('is deterministic and part of the hash', () => {
    const run = (): number[] => {
      const s = game(21);
      const out: number[] = [];
      const ops: Omit<AdminAction, 'type'>[] = [
        { op: 'setResource', key: 'gold', amount: 999 },
        { op: 'paintTiles', tile: at(s, 25, 10), amount: 4 },
        { op: 'godMode', player: 3, flag: true },
        { op: 'freezeAI', flag: true },
        { op: 'setDifficulty', key: 'hard' },
        { op: 'spawnTankDivision', tile: at(s, 10, 10) },
      ];
      for (const op of ops) {
        const before = hashState(s);
        expect(admin(s, op).ok).toBe(true);
        expect(hashState(s)).not.toBe(before);
        for (let k = 0; k < 20; k++) tick(s);
        out.push(hashState(s));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});

describe('continue after the end', () => {
  it('plays on after a victory: same winner, no new end, eliminated humans watch', () => {
    const s = game();
    s.settings.victoryLandShare = 0.3;
    for (let k = 0; k < 20 && s.phase !== 'over'; k++) tick(s);
    expect(s.phase).toBe('over');
    const winner = s.winner;
    expect(winner).toBeGreaterThan(0);
    expect(applyAction(s, 2, { type: 'continueGame' }).ok).toBe(false); // an AI
    s.players[1].alive = false; // an eliminated human may still continue as a spectator
    expect(applyAction(s, 1, { type: 'continueGame' }).ok).toBe(true);
    expect(s.phase).toBe('playing');
    expect(s.continued).toBe(true);
    s.players[1].alive = true;
    const victories = s.events.filter((e) => e.kind === 'victory').length;
    const t0 = s.tick;
    for (let k = 0; k < 60 * TICKS_PER_SECOND; k++) tick(s);
    expect(s.tick).toBe(t0 + 60 * TICKS_PER_SECOND);
    expect(s.phase).toBe('playing');
    expect(s.winner).toBe(winner);
    expect(s.events.filter((e) => e.kind === 'victory').length).toBe(victories);
    expect(applyAction(s, 1, { type: 'continueGame' }).reason).toMatch(/not over/);
  });

  it('continued games hash differently and stay deterministic', () => {
    const run = (): number => {
      const s = game(8);
      s.settings.victoryLandShare = 0.3;
      for (let k = 0; k < 20 && s.phase !== 'over'; k++) tick(s);
      applyAction(s, 1, { type: 'continueGame' });
      for (let k = 0; k < 100; k++) tick(s);
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});

// ------------------------------------------------------------------------------------------------ server

describe('server: validation of the new actions', () => {
  it('validates admin, continue, groups, tanks and buildWarship with a tile', () => {
    expect(validateAction({ type: 'continueGame', x: 1 })).toEqual({ ok: true, value: { type: 'continueGame' } });
    expect(validateAction({ type: 'admin', op: 'setResource', key: 'gold', amount: -5, junk: 1 })).toEqual({
      ok: true,
      value: { type: 'admin', op: 'setResource', key: 'gold', amount: -5 },
    });
    expect(validateAction({ type: 'admin', op: 'hack' }).ok).toBe(false);
    expect(validateAction({ type: 'admin', op: 'setResource', key: 'a b' }).ok).toBe(false);
    expect(validateAction({ type: 'admin', op: 'setTroops', troops: { infantry: -1, armor: 0, artillery: 0 } }).ok).toBe(false);
    expect(validateAction({ type: 'moveWarships', unitIds: [1, 2, 3], tile: 5 }).ok).toBe(true);
    expect(validateAction({ type: 'moveWarships', unitIds: [1, 1], tile: 5 }).ok).toBe(false);
    expect(validateAction({ type: 'moveWarships', unitIds: Array.from({ length: 65 }, (_, k) => k), tile: 5 }).ok).toBe(false);
    expect(validateAction({ type: 'moveTankDivision', unitIds: [], tile: 5 }).ok).toBe(false);
    expect(validateAction({ type: 'buildTankDivision', tile: 9 }).ok).toBe(true);
    expect(validateAction({ type: 'buildWarship', port: 4 })).toEqual({ ok: true, value: { type: 'buildWarship', port: 4 } });
    expect(validateAction({ type: 'buildWarship', port: -1, tile: 7 })).toEqual({ ok: true, value: { type: 'buildWarship', port: -1, tile: 7 } });
    expect(validateAction({ type: 'buildWarship', port: -2, tile: 7 }).ok).toBe(false);
    expect(validateClientMessage({ type: 'adminAuth', code: 'x' }).ok).toBe(true);
    expect(validateClientMessage({ type: 'adminAuth', code: '' }).ok).toBe(false);
    expect(validateClientMessage({ type: 'adminAuth', code: 'x'.repeat(200) }).ok).toBe(false);
  });

  it('AdminGate: right / wrong code, unset code, rate limit per address', () => {
    let now = 0;
    const off = new AdminGate('', () => now);
    expect(off.enabled).toBe(false);
    expect(off.attempt('1.1.1.1', 'c1', '')).toBe('wrong');
    expect(off.isAdmin('c1')).toBe(false);
    const g = new AdminGate('open sesame', () => now);
    expect(g.attempt('1.1.1.1', 'c1', 'open sesam')).toBe('wrong');
    expect(g.attempt('1.1.1.1', 'c1', 'open sesame')).toBe('ok');
    expect(g.isAdmin('c1')).toBe(true);
    expect(g.isAdmin('c2')).toBe(false);
    for (let k = 1; k < ADMIN_MAX_FAILS; k++) expect(g.attempt('2.2.2.2', 'c3', 'no')).toBe('wrong');
    expect(g.attempt('2.2.2.2', 'c3', 'no')).toBe('wrong');
    expect(g.attempt('2.2.2.2', 'c3', 'open sesame')).toBe('ignored'); // even the right code, for an hour
    expect(g.isAdmin('c3')).toBe(false);
    expect(g.attempt('3.3.3.3', 'c4', 'open sesame')).toBe('ok'); // other addresses are not affected
    now += 3600_001;
    g.sweep();
    expect(g.attempt('2.2.2.2', 'c3', 'open sesame')).toBe('ok');
  });
});

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
  close(): void {
    this.ws.close();
  }
}

const base = { port: 0, host: '127.0.0.1', publicLobbies: false, turnMs: 30, firstTurnDelayMs: 0, sweepMs: 20, createLobbyCooldownMs: 0, maxRoomsPerIp: 50, log: () => {} };

async function privateGame(srv: RunningServer, names: string[]): Promise<Client[]> {
  const cs = await Promise.all(names.map(() => Client.connect(srv.wsUrl)));
  for (let i = 0; i < cs.length; i++) await cs[i].hello(names[i]);
  cs[0].send({ type: 'createLobby', settings: { map: { kind: 'generated', type: 'pangaea', size: 'small' }, aiCount: 1 } });
  const { code } = await cs[0].take('lobbyState');
  for (const c of cs.slice(1)) {
    c.send({ type: 'joinLobby', code });
    await c.take('lobbyState');
  }
  cs[0].send({ type: 'startGame' });
  for (const c of cs) await c.take('gameStart');
  return cs;
}
const relayed = (c: Client, type: string): boolean =>
  c.inbox.some((m) => (m.type === 'turn' && m.intents.some((i) => i.action.type === type)) || (m.type === 'catchUp' && m.turns.some((t) => t.intents.some((i) => i.action.type === type))));

describe('server: owner console online', () => {
  let on: RunningServer;
  let off: RunningServer;
  beforeAll(async () => {
    on = await startServer({ ...base, adminCode: 'owner-secret' });
    off = await startServer({ ...base });
  });
  afterAll(async () => {
    await on.close();
    await off.close();
  });

  it('ADMIN_CODE unset: every code is refused and admin intents are dropped', async () => {
    const [a] = await privateGame(off, ['Solo']);
    a.send({ type: 'adminAuth', code: 'owner-secret' });
    expect(await a.take('adminAuth')).toEqual({ type: 'adminAuth', ok: false });
    a.send({ type: 'intent', action: { type: 'admin', op: 'setResource', key: 'gold', amount: 1 } });
    expect((await a.take('error')).code).toBe('notAllowed');
    await sleep(100);
    expect(relayed(a, 'admin')).toBe(false);
    a.close();
  });

  it('only the authenticated session may send admin intents; the answer goes to the sender alone', async () => {
    const [h, g] = await privateGame(on, ['Owner', 'Guest']);
    g.send({ type: 'adminAuth', code: 'guess' });
    expect(await g.take('adminAuth')).toEqual({ type: 'adminAuth', ok: false });
    g.send({ type: 'intent', action: { type: 'admin', op: 'setResource', key: 'gold', amount: 1 } });
    expect((await g.take('error')).code).toBe('notAllowed');
    h.send({ type: 'adminAuth', code: 'owner-secret' });
    expect(await h.take('adminAuth')).toEqual({ type: 'adminAuth', ok: true });
    await sleep(50);
    expect(g.has('adminAuth')).toBe(false);
    h.send({ type: 'intent', action: { type: 'admin', op: 'setResource', key: 'gold', amount: 7 } });
    await g.take('turn', (m) => m.intents.some((i) => i.action.type === 'admin' && i.playerId === 1));
    expect(relayed(g, 'admin')).toBe(false); // the guest's own attempt never reached a turn (taken above was the owner's)
    h.close();
    g.close();
  });

  it('5 wrong codes from one address: further tries are ignored silently', async () => {
    // A server of its own: every test client comes from 127.0.0.1, so earlier wrong codes would count here.
    const fresh = await startServer({ ...base, adminCode: 'owner-secret' });
    const [a] = await privateGame(fresh, ['Prober']);
    for (let k = 0; k < ADMIN_MAX_FAILS; k++) {
      a.send({ type: 'adminAuth', code: `wrong${k}` });
      expect(await a.take('adminAuth')).toEqual({ type: 'adminAuth', ok: false });
    }
    a.send({ type: 'adminAuth', code: 'owner-secret' });
    await sleep(150);
    expect(a.has('adminAuth')).toBe(false);
    a.send({ type: 'intent', action: { type: 'admin', op: 'freezeAI', flag: true } });
    expect((await a.take('error')).code).toBe('notAllowed');
    a.close();
    await fresh.close();
  });
});

describe('server: continue after the end', () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ ...base });
  });
  afterAll(async () => {
    await srv.close();
  });

  it('a finished private game is continuable; only the host continues it; turns resume for everyone', async () => {
    const [h, g] = await privateGame(srv, ['Host', 'Guest']);
    const last = await h.take('turn', (m) => m.n >= 3);
    // Before the end a guest's continueGame is refused too.
    g.send({ type: 'intent', action: { type: 'continueGame' } });
    expect((await g.take('error')).code).toBe('notHost');
    h.send({ type: 'gameOver', turn: last.n, winner: 1 });
    g.send({ type: 'gameOver', turn: last.n, winner: 1 });
    const over = await Promise.all([h.take('gameOver'), g.take('gameOver')]);
    for (const o of over) expect(o).toMatchObject({ reason: 'finished', winner: 1, continuable: true });
    await sleep(80);
    h.inbox.length = 0;
    g.inbox.length = 0;
    await sleep(100);
    expect(h.has('turn')).toBe(false);
    g.send({ type: 'intent', action: { type: 'continueGame' } });
    expect((await g.take('error')).code).toBe('notHost');
    h.send({ type: 'intent', action: { type: 'continueGame' } });
    const cont = await Promise.all([h.take('gameContinued'), g.take('gameContinued')]);
    for (const c of cont) expect(c.by).toBe(1);
    const t = await g.take('turn', (m) => m.intents.some((i) => i.action.type === 'continueGame'));
    expect(t.intents.find((i) => i.action.type === 'continueGame')!.playerId).toBe(1);
    await g.take('turn', (m) => m.n > t.n + 2);
    // Game-over reports after continuing are ignored: no second gameOver.
    h.send({ type: 'gameOver', turn: t.n, winner: 2 });
    g.send({ type: 'gameOver', turn: t.n, winner: 2 });
    await sleep(150);
    expect(g.has('gameOver')).toBe(false);
    h.close();
    g.close();
  });
});

describe('server: POST /api/admin-check (single player uses the same ADMIN_CODE)', () => {
  const post = (srv: RunningServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${srv.port}${ADMIN_CHECK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('right code -> {ok:true}; wrong, empty, odd bodies -> {ok:false}', async () => {
    const srv = await startServer({ ...base, adminCode: 'owner-secret' });
    try {
      const good = await post(srv, { code: 'owner-secret' });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ ok: true });
      expect(good.headers.get('cache-control')).toBe('no-store');
      for (const body of [{ code: 'owner-secre' }, { code: 'OWNER-SECRET' }, { code: '' }, { code: 5 }, {}, 'not json', '[]']) {
        const r = await post(srv, body);
        expect(await r.json()).toEqual({ ok: false });
      }
      expect((await fetch(`http://127.0.0.1:${srv.port}${ADMIN_CHECK_PATH}`)).status).toBe(405);
    } finally {
      await srv.close();
    }
  });

  it('ADMIN_CODE unset: every code gives {ok:false}', async () => {
    const srv = await startServer({ ...base });
    try {
      expect(await (await post(srv, { code: 'owner-secret' })).json()).toEqual({ ok: false });
      expect(await (await post(srv, { code: 'anything' })).json()).toEqual({ ok: false });
    } finally {
      await srv.close();
    }
  });

  it('5 wrong codes per address, then always {ok:false} without comparing (also the right one)', async () => {
    const srv = await startServer({ ...base, adminCode: 'owner-secret' });
    try {
      for (let k = 0; k < ADMIN_MAX_FAILS; k++) expect(await (await post(srv, { code: `wrong${k}` })).json()).toEqual({ ok: false });
      expect(await (await post(srv, { code: 'owner-secret' })).json()).toEqual({ ok: false });
      // the websocket login shares the limit
      const [a] = await privateGame(srv, ['Late']);
      a.send({ type: 'adminAuth', code: 'owner-secret' });
      await sleep(150);
      expect(a.has('adminAuth')).toBe(false);
      a.close();
    } finally {
      await srv.close();
    }
  });

  it('the check does not make anyone admin (only the websocket login does)', async () => {
    const srv = await startServer({ ...base, adminCode: 'owner-secret' });
    try {
      expect(await (await post(srv, { code: 'owner-secret' })).json()).toEqual({ ok: true });
      const [a] = await privateGame(srv, ['Plain']);
      a.send({ type: 'intent', action: { type: 'admin', op: 'freezeAI', flag: true } });
      expect((await a.take('error')).code).toBe('notAllowed');
      a.close();
    } finally {
      await srv.close();
    }
  });

  it('CORS: the GitHub Pages site and same origin pass; other origins are refused; preflight answers', async () => {
    const srv = await startServer({ ...base, adminCode: 'owner-secret' });
    try {
      const pages = await post(srv, { code: 'owner-secret' }, { Origin: PAGES_ORIGIN });
      expect(pages.headers.get('access-control-allow-origin')).toBe(PAGES_ORIGIN);
      expect(await pages.json()).toEqual({ ok: true });
      const same = `http://127.0.0.1:${srv.port}`;
      const own = await post(srv, { code: 'nope' }, { Origin: same });
      expect(own.headers.get('access-control-allow-origin')).toBe(same);
      const evil = await post(srv, { code: 'owner-secret' }, { Origin: 'https://evil.example' });
      expect(evil.status).toBe(403);
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
      expect(await evil.json()).toEqual({ ok: false });
      const pre = await fetch(`http://127.0.0.1:${srv.port}${ADMIN_CHECK_PATH}`, {
        method: 'OPTIONS',
        headers: { Origin: PAGES_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe(PAGES_ORIGIN);
      expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
      expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type');
    } finally {
      await srv.close();
    }
  });

  it('ALLOWED_ORIGINS replaces the default site; the body is size-capped', async () => {
    const srv = await startServer({ ...base, adminCode: 'owner-secret', allowedOrigins: ['https://mine.example'] });
    try {
      expect((await post(srv, { code: 'owner-secret' }, { Origin: 'https://mine.example' })).status).toBe(200);
      expect((await post(srv, { code: 'owner-secret' }, { Origin: PAGES_ORIGIN })).status).toBe(403);
      const big = await post(srv, { code: 'x'.repeat(ADMIN_CHECK_MAX_BYTES + 10) });
      expect(big.status).toBe(413);
      expect(await big.json()).toEqual({ ok: false });
      // a too-long code inside the cap is refused without being compared
      expect(await (await post(srv, { code: 'x'.repeat(500) })).json()).toEqual({ ok: false });
    } finally {
      await srv.close();
    }
  });
});
