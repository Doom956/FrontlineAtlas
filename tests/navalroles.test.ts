// What each warship type does by itself (src/sim/navalroles.ts and its hooks in navy.ts, units.ts, naval2.ts):
// submarines hunt trade and landings from hiding, destroyers sweep and escort, ships cover own landings; AI nations
// from Normal up, a player's ships on 'auto' (orders and other stances are kept).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { ARSENAL, NAVAL_ROLES, NAVY_BLOCKADE_RANGE, TECH_EFFECTS, WARSHIP_RANGE } from '../src/sim/config';
import { waterPath } from '../src/sim/grid';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { aiNavy, portBlockadedBy, warshipMaxHp } from '../src/sim/naval2';
import { chaseAim, coverLanding, gunRank, roleRank, rolesOn, subStationWater, subThreat } from '../src/sim/navalroles';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnWarshipAt } from '../src/sim/units';
import { applyWarshipVariant } from '../src/sim/variants';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, Difficulty, GameState, NavalVariant, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 120x60: land y 0..19 (player 1 human x 0..59, player 2 AI x 60..119), open sea y 20..59; AIs frozen. */
function seaGame(difficulty: Difficulty = 'normal', seed = 5): GameState {
  const s = makeFlatGame(120, 60, 3, { human: true, seed });
  for (let y = 20; y < 60; y++) for (let x = 0; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 59, 19);
  claimRect(s, 2, 60, 0, 119, 19);
  s.settings.difficulty = difficulty;
  s.settings.victoryLandShare = 0.99;
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('navigation');
  }
  return s;
}
/** Players 1 and 2 at war (the recent-war memory, naval2.updateWarMemory keeps it). */
function war(s: GameState): void {
  s.warMemory = [1, 2, 1e9];
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function ship(s: GameState, owner: number, x: number, y: number, v?: NavalVariant): Unit {
  const u = spawnWarshipAt(s, owner, at(s, owner === 1 ? 20 : 90, 19), at(s, x, y));
  applyWarshipVariant(u, v);
  return u;
}
/** A transport or trade ship of `owner` at (x, y) sailing to (tx, ty). */
function boat(s: GameState, type: 'transport' | 'tradeShip', owner: number, x: number, y: number, tx: number, ty: number, targetOwner = 0): Unit {
  const path = waterPath(s.map, at(s, x, y), at(s, tx, ty)) ?? [];
  const u: Unit = {
    id: newId(s),
    type,
    owner,
    x,
    y,
    target: path.length ? path[path.length - 1] : at(s, tx, ty),
    home: at(s, x, y),
    path,
    pathPos: 0,
    troops: { infantry: type === 'transport' ? 5000 : 0, armor: 0, artillery: 0 },
    hp: 1,
    cargo: type === 'tradeShip' ? 100 : 0,
    state: 0,
    targetOwner,
  };
  s.units.push(u);
  return u;
}
const dist = (u: Unit, x: number, y: number): number => Math.sqrt((u.x - x) * (u.x - x) + (u.y - y) * (u.y - y));
function run(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) tick(s);
}

describe('whose ships play their role', () => {
  it("every player's, AI nations' from Normal up (Easy keeps the old habits)", () => {
    const s = seaGame('easy');
    expect(rolesOn(s, 1)).toBe(true);
    expect(rolesOn(s, 2)).toBe(false);
    s.settings.difficulty = 'normal';
    expect(rolesOn(s, 2)).toBe(true);
  });
});

describe('submarines hunt', () => {
  it('go for transports, then trade ships; only soft warships; never a destroyer or a guarded prey', () => {
    const s = seaGame();
    war(s);
    const sub = ship(s, 2, 90, 45, 'submarine');
    const whole = ship(s, 1, 60, 45);
    ship(s, 1, 62, 47); // its fleet mate
    const lone = ship(s, 1, 20, 55);
    const dd = ship(s, 1, 110, 25, 'destroyer');
    const tr = boat(s, 'transport', 1, 40, 30, 100, 21, 2);
    const trade = boat(s, 'tradeShip', 1, 30, 50, 10, 50);
    const ships = s.units;
    expect(roleRank(s, sub, tr, 0, ships)).toBe(0);
    expect(roleRank(s, sub, trade, 2, ships)).toBe(1);
    expect(roleRank(s, sub, whole, 1, ships)).toBe(-1); // a fleet: no head-on fight
    expect(roleRank(s, sub, lone, 1, ships)).toBe(2); // alone: soft prey
    whole.hp = warshipMaxHp(whole) * 0.3;
    expect(roleRank(s, sub, whole, 1, ships)).toBe(2); // damaged: soft prey
    expect(roleRank(s, sub, dd, 1, ships)).toBe(-1);
    // A destroyer by the trade ship guards it.
    ship(s, 1, 32, 48, 'destroyer');
    expect(roleRank(s, sub, trade, 2, ships)).toBe(-1);
    // Easy AI submarines keep the plain ranks.
    s.settings.difficulty = 'easy';
    expect(roleRank(s, sub, trade, 2, ships)).toBe(2);
    expect(roleRank(s, sub, dd, 1, ships)).toBe(1);
  });

  it('meet a transport ahead on its route, and shoot from standoff range', () => {
    const s = seaGame();
    war(s);
    const sub = ship(s, 2, 80, 55, 'submarine');
    const tr = boat(s, 'transport', 1, 10, 30, 110, 30, 2);
    const aim = chaseAim(s, sub, tr);
    expect(aim).toBeGreaterThanOrEqual(0);
    expect(aim % s.map.width).toBeGreaterThan(30); // well ahead of the transport (x 10), not on its tail
    // Within standoff range: it holds and fires (others only fire back within subTargetRange).
    sub.x = 40;
    sub.y = 30 + NAVAL_ROLES.standoff * WARSHIP_RANGE - 3;
    tr.x = 40;
    expect(chaseAim(s, sub, tr)).toBe(-1);
    expect(NAVAL_ROLES.standoff * WARSHIP_RANGE).toBeGreaterThan(ARSENAL.subTargetRange);
  });

  it('an AI submarine on hunt chases trade ships of its war anywhere in its sea and sinks them', () => {
    const s = seaGame();
    war(s);
    const sub = ship(s, 2, 115, 58, 'submarine');
    asAI(s, () => applyAction(s, 2, { type: 'setUnitStance', unitIds: [sub.id], stance: 'hunt' }));
    const trade = boat(s, 'tradeShip', 1, 5, 40, 55, 40);
    trade.path = trade.path.concat(waterPath(s.map, at(s, 55, 40), at(s, 5, 40)) ?? []);
    run(s, 300);
    expect(trade.hp).toBeLessThanOrEqual(0);
  });

  it('dive away from a destroyer: AI ones on any stance, a player\'s on auto only, not Easy AI ones', () => {
    const play = (owner: number, stance: 'auto' | 'hunt' | 'blockade', difficulty: Difficulty = 'normal'): Unit => {
      const s = seaGame(difficulty);
      war(s);
      const sub = ship(s, owner, 60, 45, 'submarine');
      const set = (): unknown => applyAction(s, owner, { type: 'setUnitStance', unitIds: [sub.id], stance });
      if (owner === 2) asAI(s, set);
      else set();
      ship(s, owner === 1 ? 2 : 1, 60 + ARSENAL.destroyerSonar - 4, 45, 'destroyer');
      expect(subThreat(s, sub, s.units)).not.toBeNull();
      for (let k = 0; k < 40 && sub.state !== 1; k++) tick(s);
      return sub;
    };
    expect(play(2, 'hunt').state).toBe(1);
    expect(play(2, 'blockade').state).toBe(1);
    expect(play(1, 'auto').state).toBe(1);
    expect(play(1, 'hunt').state).not.toBe(1); // a player's own stance is kept
    expect(play(2, 'hunt', 'easy').state).not.toBe(1);
  });

  it('a lone whole warship that sees it up close does not scare it off; outgunned and damaged, it dives', () => {
    const s = seaGame();
    war(s);
    const sub = ship(s, 2, 60, 45, 'submarine');
    const bb = ship(s, 1, 60 + ARSENAL.subTargetRange - 2, 45);
    expect(subThreat(s, sub, s.units)).toBeNull();
    sub.hp = warshipMaxHp(sub) * 0.3;
    expect(subThreat(s, sub, s.units)).not.toBeNull();
    sub.hp = warshipMaxHp(sub);
    ship(s, 1, bb.x, 47);
    ship(s, 1, bb.x, 43);
    expect(subThreat(s, sub, s.units)).not.toBeNull();
  });

  it('blockade from a hidden spot inside the longer range, outside minefields; Easy AI ones park at the port', () => {
    const play = (difficulty: Difficulty): { s: GameState; sub: Unit; port: number } => {
      const s = seaGame(difficulty);
      war(s);
      const port = at(s, 30, 19);
      addBuilding(s, 'port', 1, port);
      const sub = ship(s, 2, 100, 50, 'submarine');
      asAI(s, () => applyAction(s, 2, { type: 'setUnitStance', unitIds: [sub.id], stance: 'blockade' }));
      for (let k = 0; k < 900 && !(sub.state === 3 && sub.pathPos >= sub.path.length); k++) tick(s);
      return { s, sub, port };
    };
    const { s, sub, port } = play('normal');
    expect(sub.state).toBe(3);
    const range = NAVY_BLOCKADE_RANGE * ARSENAL.naval.submarine.blockade;
    const d = dist(sub, 30, 19);
    expect(d).toBeLessThanOrEqual(range);
    expect(d).toBeGreaterThan(TECH_EFFECTS.submarineRevealRange); // farther than player 1's coast reveals it
    expect(sub.y - 19).toBeGreaterThan(TECH_EFFECTS.submarineRevealRange);
    expect(portBlockadedBy(s, port)).toBe(2);
    const easy = play('easy');
    expect(dist(easy.sub, 30, 19)).toBeLessThanOrEqual(5);
    // Naval Mines: the spot is outside the minefield (mines reach 9 tiles from a level-1 port).
    s.players[1].techs.push('navalMines');
    const spot = subStationWater(s, sub, port);
    expect(spot).toBeGreaterThanOrEqual(0);
    expect(Math.hypot((spot % s.map.width) - 30, Math.floor(spot / s.map.width) - 19)).toBeGreaterThan(9);
  });

  it("a player's auto submarine at war blockades the enemy's port instead of parking off a coast it cannot shell", () => {
    const s = seaGame();
    war(s);
    const port = at(s, 90, 19);
    addBuilding(s, 'port', 2, port);
    const sub = ship(s, 1, 20, 50, 'submarine');
    for (let k = 0; k < 900 && !(sub.state === 3 && sub.pathPos >= sub.path.length); k++) tick(s);
    expect(sub.state).toBe(3);
    expect(sub.station).toBe(port);
    expect(portBlockadedBy(s, port)).toBe(1);
  });
});

describe('ships hit by a submarine they cannot see', () => {
  it("a player's auto ship sails away; its destroyer heads for the submarine; a hold ship stays", () => {
    const play = (v: NavalVariant | undefined, stance: 'auto' | 'hold' = 'auto'): { u: Unit; sub: Unit } => {
      const s = seaGame();
      war(s);
      const u = ship(s, 1, 40, 40, v);
      if (stance !== 'auto') applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance });
      const sub = ship(s, 2, 40 + ARSENAL.destroyerSonar + 6, 40, 'submarine');
      asAI(s, () => applyAction(s, 2, { type: 'setUnitStance', unitIds: [sub.id], stance: 'hold' }));
      u.hp = warshipMaxHp(u) - 0.5;
      for (let k = 0; k < 12 && u.state !== 1; k++) tick(s);
      return { u, sub };
    };
    const plain = play(undefined);
    expect(plain.u.state).toBe(1);
    const end = plain.u.path[plain.u.path.length - 1];
    expect(end % 120).toBeLessThan(40); // away from the submarine (east of it)
    const dd = play('destroyer');
    expect(dd.u.state).toBe(1);
    const ddEnd = dd.u.path[dd.u.path.length - 1];
    expect(Math.abs((ddEnd % 120) - dd.sub.x)).toBeLessThan(6);
    expect(play(undefined, 'hold').u.state).not.toBe(1);
  });
});

describe('gunnery by type', () => {
  it('a submarine shoots the transport in range before a warship; a destroyer the submarine', () => {
    const sub = { type: 'warship', variant: 'submarine' } as Unit;
    const dd = { type: 'warship', variant: 'destroyer' } as Unit;
    const plain = { type: 'warship' } as Unit;
    const tr = { type: 'transport' } as Unit;
    const trade = { type: 'tradeShip' } as Unit;
    expect(gunRank(sub, tr)).toBeLessThan(gunRank(sub, trade));
    expect(gunRank(sub, trade)).toBeLessThan(gunRank(sub, plain));
    expect(gunRank(sub, plain)).toBeLessThan(gunRank(sub, dd));
    expect(gunRank(dd, sub)).toBeLessThan(gunRank(dd, plain));
    expect(gunRank(plain, sub)).toBe(gunRank(plain, tr)); // a standard ship: the nearest, as before
    const s = seaGame();
    war(s);
    const u = ship(s, 2, 60, 45, 'submarine');
    const enemy = ship(s, 1, 60, 50); // nearer
    const t = boat(s, 'transport', 1, 60, 30, 60, 21, 2);
    t.path = [];
    for (let k = 0; k < 20 && t.hp > 0; k++) tick(s);
    expect(t.hp).toBeLessThanOrEqual(0);
    expect(enemy.hp).toBe(warshipMaxHp(enemy)); // the nearer warship waited
  });
});

describe('destroyers sweep and escort', () => {
  it("a player's auto destroyer at war escorts an own transport at sea", () => {
    const s = seaGame();
    war(s);
    const dd = ship(s, 1, 20, 45, 'destroyer');
    const tr = boat(s, 'transport', 1, 30, 25, 100, 21, 2);
    run(s, 41);
    expect(dd.state).toBe(4);
    expect(dd.station).toBe(tr.id);
  });

  it('sails to an own blockaded port, finds the submarine by sonar and sinks it', () => {
    const s = seaGame();
    war(s);
    const port = at(s, 30, 19);
    addBuilding(s, 'port', 1, port);
    const sub = ship(s, 2, 30, 32, 'submarine');
    asAI(s, () => applyAction(s, 2, { type: 'setUnitStance', unitIds: [sub.id], stance: 'blockade' }));
    s.settings.difficulty = 'easy'; // the raider stays put (no diving away)
    const dd = ship(s, 1, 110, 55, 'destroyer');
    expect(portBlockadedBy(s, port)).toBe(2);
    for (let k = 0; k < 1500 && sub.hp > 0; k++) tick(s);
    expect(sub.hp).toBeLessThanOrEqual(0);
    expect(dist(dd, 30, 19)).toBeLessThan(40);
  });

  it('a stance set by the player is kept: a hold destroyer does not leave its post', () => {
    const s = seaGame();
    war(s);
    const dd = ship(s, 1, 20, 45, 'destroyer');
    applyAction(s, 1, { type: 'setUnitStance', unitIds: [dd.id], stance: 'hold' });
    boat(s, 'transport', 1, 30, 25, 100, 21, 2);
    run(s, 41);
    expect(dd.state).not.toBe(4);
  });
});

describe('ships cover own landings', () => {
  it('the nearest free auto ship sails to an own landing on a nation, one per landing', () => {
    const s = seaGame();
    war(s);
    const near = ship(s, 1, 60, 40);
    const far = ship(s, 1, 10, 55);
    const tr = boat(s, 'transport', 1, 20, 25, 110, 21, 2);
    expect(coverLanding(s, far, () => true)).toBe(false);
    let to = -1;
    expect(coverLanding(s, near, (t) => ((to = t), true))).toBe(true);
    expect(to).toBe(tr.target);
    run(s, 41);
    expect(near.state).toBe(1);
    expect(dist(near, 110, 21)).toBeLessThan(dist(far, 110, 21));
    expect(far.state).not.toBe(1);
  });

  it('AI fleets: a destroyer escorts the landing; a foe with Submarines keeps every other destroyer on auto', () => {
    const s = seaGame();
    war(s);
    s.attacks.push({ id: newId(s), attacker: 2, target: 1, troops: { infantry: 5000, armor: 0, artillery: 0 } } as unknown as GameState['attacks'][number]);
    const plain = ship(s, 2, 85, 35);
    const dd = ship(s, 2, 100, 40, 'destroyer');
    const dd2 = ship(s, 2, 105, 40, 'destroyer');
    boat(s, 'transport', 2, 95, 25, 10, 21, 1);
    const acts: string[] = [];
    asAI(s, () => aiNavy(s, 2, (a) => (acts.push(JSON.stringify(a)), applyAction(s, 2, a))));
    expect(dd.stance === 'escort' || dd2.stance === 'escort').toBe(true);
    expect(plain.stance).not.toBe('escort');
    s.players[1].techs.push('submarines');
    const odd = [dd, dd2].find((u) => u.id % 2 === 1 && u.stance !== 'escort');
    asAI(s, () => aiNavy(s, 2, (a) => applyAction(s, 2, a)));
    if (odd) expect(odd.stance ?? 'auto').toBe('auto');
  });
});

describe('determinism', () => {
  it('two games with raiders, sweepers and landings hash the same', () => {
    const play = (): number => {
      const s = seaGame('normal', 11);
      war(s);
      addBuilding(s, 'port', 1, at(s, 30, 19));
      addBuilding(s, 'port', 2, at(s, 90, 19));
      ship(s, 1, 20, 45, 'destroyer');
      ship(s, 1, 40, 50);
      ship(s, 2, 100, 50, 'submarine');
      const sub2 = ship(s, 2, 80, 30, 'submarine');
      asAI(s, () => applyAction(s, 2, { type: 'setUnitStance', unitIds: [sub2.id], stance: 'blockade' }));
      boat(s, 'transport', 1, 30, 25, 110, 21, 2);
      boat(s, 'tradeShip', 2, 90, 25, 10, 40);
      run(s, 400);
      return hashState(s);
    };
    expect(play()).toBe(play());
  }, 60000);
});

/** Runs fn with the AIs awake (their orders go through), then freezes them again. */
function asAI<T>(s: GameState, fn: () => T): T {
  s.admin!.aiFrozen = false;
  try {
    return fn();
  } finally {
    s.admin!.aiFrozen = true;
  }
}
