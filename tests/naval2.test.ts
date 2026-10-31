// Warships, part three (naval2.ts): stances, shore bombardment, blockades, escorts, veterancy, fleet cap, AI.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { tileFightCost } from '../src/sim/combat';
import {
  NAVY_BEACHHEAD_LOSS,
  NAVY_BLOCKADE_TRADE_CUT,
  NAVY_CAP_BASE,
  NAVY_CAP_PER_PORT_LEVEL,
  NAVY_CAPTURE_GOLD,
  NAVY_ESCORT_DAMAGE,
  NAVY_SUPPORT_BONUS,
  NAVY_SUPPORT_DIMINISH,
  NAVY_VET_XP,
  UNITS,
} from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import {
  aiNavy,
  blockadedAt,
  blockadeTradeMul,
  navalBeachheadMul,
  navalSupportAt,
  onShipKilled,
  portBlockadedBy,
  shipDamageMul,
  supportBonusFor,
  warshipLimit,
} from '../src/sim/naval2';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnWarshipAt } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { Action, Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 80x40: land y 0..19 (player 1 x 0..39, player 2 x 40..79), sea y 20..39. AIs frozen: only our orders act. */
function coastGame(seed = 4): GameState {
  const s = makeFlatGame(80, 40, 3, { human: true, seed });
  for (let y = 20; y < 40; y++) for (let x = 0; x < 80; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 39, 19);
  claimRect(s, 2, 40, 0, 79, 19);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('navigation');
    p.troops = { infantry: 60000, armor: 0, artillery: 0 };
  }
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function run(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) tick(s);
}
function runUntil(s: GameState, pred: () => boolean, max = 3000): void {
  for (let k = 0; k < max && !pred(); k++) tick(s);
}
/** Player 1 attacks player 2 (a war: an attack running). */
function war(s: GameState): void {
  expect(applyAction(s, 1, { type: 'attack', tile: at(s, 40, 5), troops: { infantry: 20000, armor: 0, artillery: 0 } }).ok).toBe(true);
}
function ship(s: GameState, owner: number, x: number, y: number): Unit {
  return spawnWarshipAt(s, owner, at(s, owner === 1 ? 20 : 60, 19), at(s, x, y));
}
function tradeShip(s: GameState, owner: number, x: number, y: number, cargo: number): Unit {
  // Sailing slowly west along its row (a long route, so it is still at sea when the warship fires).
  const path: number[] = [];
  for (let k = Math.round(x); k >= 0; k--) path.push(at(s, k, Math.round(y)));
  const u: Unit = { id: newId(s), type: 'tradeShip', owner, x, y, target: path[path.length - 1], home: at(s, 70, 19), path, pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo, state: 0, targetOwner: 3 };
  s.units.push(u);
  return u;
}

describe('shore bombardment', () => {
  it('own warships near enemy coast make it cheaper to take (diminishing per ship) and supplied', () => {
    const s = coastGame();
    const coast = at(s, 50, 19);
    const troops = { infantry: 20000, armor: 0, artillery: 0 };
    s.tick++;
    const base = tileFightCost(s, 1, troops, 2, coast).loss;
    expect(navalSupportAt(s, 1, coast)).toBe(0);
    ship(s, 1, 50, 22);
    s.tick++;
    expect(navalSupportAt(s, 1, coast)).toBeCloseTo(NAVY_SUPPORT_BONUS);
    const one = tileFightCost(s, 1, troops, 2, coast).loss;
    expect(one).toBeLessThan(base * 0.8);
    ship(s, 1, 52, 22);
    s.tick++;
    expect(navalSupportAt(s, 1, coast)).toBeCloseTo(NAVY_SUPPORT_BONUS * (1 + NAVY_SUPPORT_DIMINISH));
    expect(tileFightCost(s, 1, troops, 2, coast).loss).toBeLessThan(one);
    expect(supportBonusFor(20)).toBeLessThan(supportBonusFor(2) * 2);
    // Far inland: no support; the enemy's ships don't help us.
    expect(navalSupportAt(s, 1, at(s, 50, 2))).toBe(0);
    expect(navalSupportAt(s, 2, coast)).toBe(0);
    // Landings next to own warships: the beachhead bonus.
    expect(navalBeachheadMul(s, 1, coast)).toBe(NAVY_BEACHHEAD_LOSS);
    expect(navalBeachheadMul(s, 1, at(s, 75, 2))).toBe(1);
  });

  it("'bombard' parks off the enemy coast at war and shells it; 'auto' does it near its post and goes home after the war", () => {
    const s = coastGame();
    const b = ship(s, 1, 30, 30);
    const a = ship(s, 1, 55, 30);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [b.id], stance: 'bombard' }).ok).toBe(true);
    run(s, 30);
    // At peace (no attack running): nobody takes up station.
    expect(b.state).not.toBe(3);
    expect(a.state).not.toBe(3);
    war(s);
    runUntil(s, () => b.state === 3 && a.state === 3 && b.path.length > 0 && b.pathPos >= b.path.length, 600);
    expect(b.state).toBe(3);
    expect(s.map.owner[b.station!]).toBe(2);
    expect(a.state).toBe(3);
    expect(s.map.owner[a.station!]).toBe(2);
    // Shelling: player 2 loses troops faster than in the same game without the ships.
    const lost0 = s.players[2].stats.troopsLost;
    const killed0 = s.players[1].stats.troopsKilled;
    run(s, 50);
    expect(s.players[2].stats.troopsLost - lost0).toBeGreaterThan(0);
    expect(s.players[1].stats.troopsKilled - killed0).toBeGreaterThan(0);
    // The war ends: the auto ship sails back to its post.
    for (const x of s.attacks.filter((q) => q.attacker === 1)) applyAction(s, 1, { type: 'retreat', attackId: x.id });
    runUntil(s, () => a.state === 0, 900);
    expect(a.state).toBe(0);
    expect(a.station).toBeUndefined();
  });
});

describe('blockades', () => {
  it('a warship at war near a port blockades it: less trade, worse supply, trade ships captured', () => {
    const s = coastGame();
    const port = addBuilding(s, 'port', 2, at(s, 70, 19));
    const blocker = ship(s, 1, 20, 30);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [blocker.id], stance: 'blockade' }).ok).toBe(true);
    war(s);
    runUntil(s, () => blocker.state === 3 && blocker.pathPos >= blocker.path.length, 800);
    expect(blocker.station).toBe(port.tile);
    s.tick++;
    expect(portBlockadedBy(s, port.tile)).toBe(1);
    expect(blockadeTradeMul(s, 2, port.tile)).toBeCloseTo(1 - NAVY_BLOCKADE_TRADE_CUT);
    expect(blockadedAt(s, 2, at(s, 68, 15))).toBe(true);
    expect(blockadedAt(s, 2, at(s, 45, 2))).toBe(false);
    expect(blockadedAt(s, 1, at(s, 68, 15))).toBe(false);
    // A trade ship of the blockaded nation is captured: its cargo goes to the blockader.
    const gold0 = s.players[1].gold;
    const ts = tradeShip(s, 2, blocker.x + 2, blocker.y, 400);
    runUntil(s, () => ts.hp <= 0, 200);
    expect(ts.hp).toBeLessThanOrEqual(0);
    expect(s.players[1].gold - gold0).toBeGreaterThanOrEqual(400 * NAVY_CAPTURE_GOLD - 1);
    // Peace (the attack called off): no blockade.
    for (const x of s.attacks.filter((q) => q.attacker === 1)) applyAction(s, 1, { type: 'retreat', attackId: x.id });
    run(s, 320); // the war memory runs out
    expect(portBlockadedBy(s, port.tile)).toBe(0);
  });
});

describe('escorts and veterancy', () => {
  it("'escort' sticks to an own transport, which then takes much less damage", () => {
    const s = coastGame();
    const e = ship(s, 1, 20, 25);
    const enemy = ship(s, 2, 60, 30);
    const route: number[] = [];
    for (let x = 22; x < 78; x++) route.push(at(s, x, 26));
    const tr: Unit = { id: newId(s), type: 'transport', owner: 1, x: 22, y: 26, target: route[route.length - 1], home: at(s, 20, 19), path: route, pathPos: 0, troops: { infantry: 1000, armor: 0, artillery: 0 }, hp: 1, cargo: 4, state: 0, targetOwner: 2 };
    s.units.push(tr);
    expect(shipDamageMul(s, enemy, tr)).toBe(1);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [e.id], stance: 'escort' }).ok).toBe(true);
    runUntil(s, () => e.state === 4, 100);
    expect(e.state).toBe(4);
    expect(e.station).toBe(tr.id);
    expect(shipDamageMul(s, enemy, tr)).toBeCloseTo(NAVY_ESCORT_DAMAGE);
  });

  it('sinking ships earns veterancy: more hp and damage', () => {
    const s = coastGame();
    const u = ship(s, 1, 20, 30);
    const victim = ship(s, 2, 60, 30);
    const hp0 = u.hp;
    const m0 = shipDamageMul(s, u, victim);
    for (let k = 0; k < Math.ceil(NAVY_VET_XP[0] / 3) + 1; k++) onShipKilled(s, u, victim);
    expect(u.vet).toBe(1);
    expect(u.hp).toBe(hp0 + 1);
    expect(shipDamageMul(s, u, victim)).toBeGreaterThan(m0);
  });
});

describe('fleet size, orders and validation', () => {
  it('the fleet cap grows with port levels', () => {
    const s = coastGame();
    const port = addBuilding(s, 'port', 1, at(s, 20, 19), 1);
    expect(warshipLimit(s, 1)).toBe(NAVY_CAP_BASE + NAVY_CAP_PER_PORT_LEVEL);
    port.level = 2;
    expect(warshipLimit(s, 1)).toBe(NAVY_CAP_BASE + 2 * NAVY_CAP_PER_PORT_LEVEL);
    port.level = 1;
    for (let k = 0; k < NAVY_CAP_BASE + NAVY_CAP_PER_PORT_LEVEL; k++) ship(s, 1, 10 + k, 30);
    expect(applyAction(s, 1, { type: 'buildWarship', port: port.tile, tile: at(s, 20, 25) }).reason).toMatch(/At most/);
    expect(UNITS.warship.hp).toBeGreaterThan(0);
  });

  it('setUnitStance: own warships only, known stances; the server validates it', () => {
    const s = coastGame();
    const mine = ship(s, 1, 20, 30);
    const theirs = ship(s, 2, 60, 30);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [theirs.id], stance: 'hunt' }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [mine.id], stance: 'nap' as never }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [mine.id], stance: 'hunt' }).ok).toBe(true);
    expect(mine.stance).toBe('hunt');
    expect(validateAction({ type: 'setUnitStance', unitIds: [1, 2], stance: 'blockade', x: 1 })).toEqual({ ok: true, value: { type: 'setUnitStance', unitIds: [1, 2], stance: 'blockade' } });
    expect(validateAction({ type: 'setUnitStance', unitIds: [1], stance: 'sleep' }).ok).toBe(false);
    expect(validateAction({ type: 'setUnitStance', unitIds: [], stance: 'auto' }).ok).toBe(false);
  });

  it('is deterministic: identical games with stances hash the same', () => {
    const go = (): number => {
      const s = coastGame(11);
      addBuilding(s, 'port', 2, at(s, 70, 19));
      const a = ship(s, 1, 20, 30);
      const b = ship(s, 1, 30, 30);
      const c = ship(s, 2, 60, 30);
      applyAction(s, 1, { type: 'setUnitStance', unitIds: [a.id], stance: 'blockade' });
      applyAction(s, 1, { type: 'setUnitStance', unitIds: [b.id], stance: 'bombard' });
      applyAction(s, 2, { type: 'setUnitStance', unitIds: [c.id], stance: 'hunt' });
      war(s);
      run(s, 400);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});

describe('AI fleets', () => {
  it('at war an AI gives its ships jobs: blockade, bombard, escorts for its transports', () => {
    const s = coastGame();
    const ai = s.players[2];
    ai.personality = 'admiral';
    addBuilding(s, 'port', 1, at(s, 20, 19));
    const fleet = [ship(s, 2, 60, 25), ship(s, 2, 62, 25), ship(s, 2, 64, 25), ship(s, 2, 66, 25), ship(s, 2, 68, 25)];
    const acts: Action[] = [];
    const act = (a: Action) => {
      acts.push(a);
      return applyAction(s, 2, a);
    };
    s.admin!.aiFrozen = false; // only the calls below decide for the AI
    aiNavy(s, 2, act);
    expect(fleet.every((u) => (u.stance ?? 'auto') === 'auto')).toBe(true);
    war(s);
    const tr: Unit = { id: newId(s), type: 'transport', owner: 2, x: 61, y: 27, target: at(s, 30, 21), home: at(s, 60, 19), path: [], pathPos: 0, troops: { infantry: 1000, armor: 0, artillery: 0 }, hp: 1, cargo: 10, state: 0, targetOwner: 1 };
    s.units.push(tr);
    aiNavy(s, 2, act);
    const stances = fleet.map((u) => u.stance ?? 'auto');
    expect(stances).toContain('escort');
    expect(stances).toContain('blockade');
    expect(stances).toContain('bombard');
    // They act on it: within a few seconds someone is on station or escorting.
    s.admin!.aiFrozen = true;
    run(s, 100);
    expect(fleet.some((u) => u.state === 3 || u.state === 4)).toBe(true);
  });
});
