// Warships, part two (navy.ts): ordering a warship on a clicked water tile, auto-intercept, group moves.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { UNITS, WARSHIP_BUILD_SECONDS, WARSHIP_LEASH, WARSHIP_SPAWN_RANGE, TICKS_PER_SECOND } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { formationTiles, updateNavyQueue, warshipSpawnPort } from '../src/sim/navy';
import { newId } from '../src/sim/state';
import { spawnWarshipAt, updateUnits } from '../src/sim/units';
import { Terrain, isWater } from '../src/sim/types';
import type { Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 140x40: land x 0..19 (player 1, human), sea x 20..119, land x 120..139 (player 2); a lake at 5..7 x 5..7. */
function seaGame(seed = 7): GameState {
  const s = makeFlatGame(140, 40, 2, { human: true, seed });
  for (let y = 0; y < 40; y++) for (let x = 20; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) s.map.terrain[at(s, x, y)] = Terrain.ShallowWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 19, 39);
  claimRect(s, 2, 120, 0, 139, 39);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('navigation');
  }
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function step(s: GameState, n = 1): void {
  for (let k = 0; k < n; k++) {
    updateUnits(s);
    updateNavyQueue(s);
    s.tick++;
  }
}
function runUntil(s: GameState, pred: () => boolean, max = 3000): number {
  let k = 0;
  for (; k < max && !pred(); k++) step(s);
  return k;
}
const ships = (s: GameState, owner?: number): Unit[] => s.units.filter((u) => u.type === 'warship' && u.hp > 0 && (owner === undefined || u.owner === owner));

describe('warship spawn where you click', () => {
  it('needs water reachable from an own port within WARSHIP_SPAWN_RANGE; appears after the build time', () => {
    const s = seaGame();
    const port = addBuilding(s, 'port', 1, at(s, 19, 20));
    const order = (tile: number, p = port.tile) => applyAction(s, 1, { type: 'buildWarship', port: p, tile });
    expect(order(at(s, 10, 20)).reason).toMatch(/water/);
    expect(order(at(s, 19 + WARSHIP_SPAWN_RANGE + 5, 20)).reason).toMatch(/Too far/);
    expect(order(at(s, 6, 6)).reason).toMatch(/reached by sea/); // the lake
    expect(applyAction(s, 2, { type: 'buildWarship', port: port.tile, tile: at(s, 30, 20) }).reason).toMatch(/Port of yours/);
    const gold = s.players[1].gold;
    const target = at(s, 40, 25);
    expect(order(target).ok).toBe(true);
    expect(s.players[1].gold).toBe(gold - UNITS.warship.gold); // paid at the order
    expect(ships(s, 1).length).toBe(0);
    expect(s.unitQueue?.length).toBe(1);
    step(s, Math.round(WARSHIP_BUILD_SECONDS * TICKS_PER_SECOND) - 2);
    expect(ships(s, 1).length).toBe(0);
    step(s, 3);
    const w = ships(s, 1)[0];
    expect(w).toBeDefined();
    expect(at(s, Math.round(w.x), Math.round(w.y))).toBe(target);
    expect(w.cargo).toBe(target);
    expect(s.events.some((e) => e.kind === 'warshipReady' && e.players.includes(1))).toBe(true);
  });

  it('port -1 picks the nearest suitable port; the old form (no tile) still works', () => {
    const s = seaGame();
    addBuilding(s, 'port', 1, at(s, 19, 5));
    const near = addBuilding(s, 'port', 1, at(s, 19, 30));
    const r = warshipSpawnPort(s, 1, -1, at(s, 25, 32));
    expect(typeof r === 'string' ? r : r.id).toBe(near.id);
    expect(applyAction(s, 1, { type: 'buildWarship', port: -1, tile: at(s, 25, 32) }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'buildWarship', port: near.tile }).ok).toBe(true);
    expect(s.unitQueue?.length).toBe(2);
    step(s, Math.round(WARSHIP_BUILD_SECONDS * TICKS_PER_SECOND) + 1);
    expect(ships(s, 1).length).toBe(2);
    for (const w of ships(s, 1)) expect(isWater(s.map.terrain[w.cargo])).toBe(true);
  });

  it('a lost port loses the ship being built', () => {
    const s = seaGame();
    const port = addBuilding(s, 'port', 1, at(s, 19, 20));
    expect(applyAction(s, 1, { type: 'buildWarship', port: port.tile, tile: at(s, 30, 20) }).ok).toBe(true);
    port.owner = 2;
    markBuildingsChanged(s);
    step(s, Math.round(WARSHIP_BUILD_SECONDS * TICKS_PER_SECOND) + 1);
    expect(ships(s).length).toBe(0);
    expect(s.unitQueue?.length).toBe(0);
  });
});

describe('warship auto-intercept', () => {
  it('chases an enemy ship seen within detection range, sinks it, then sails back to its post', () => {
    const s = seaGame();
    const hunter = spawnWarshipAt(s, 2, at(s, 119, 2), at(s, 70, 2));
    const prey = spawnWarshipAt(s, 1, at(s, 20, 38), at(s, 70, 32));
    prey.hp = 0.5; // weak: it loses the duel
    prey.path = [];
    let chased = false;
    runUntil(s, () => {
      if (hunter.state === 2 && hunter.chase === prey.id) chased = true;
      return prey.hp <= 0 || !s.units.includes(prey);
    }, 1500);
    expect(chased).toBe(true);
    expect(prey.hp).toBeLessThanOrEqual(0);
    // Back on station.
    runUntil(s, () => hunter.state === 0 && Math.abs(hunter.x - 70) + Math.abs(hunter.y - 2) < 3, 1500);
    expect(hunter.state).toBe(0);
    expect(hunter.cargo).toBe(at(s, 70, 2));
  });

  it('gives up on a target beyond the leash, and ignores allies and peace time', () => {
    const s = seaGame();
    const hunter = spawnWarshipAt(s, 2, at(s, 119, 2), at(s, 70, 2));
    const prey = spawnWarshipAt(s, 1, at(s, 20, 38), at(s, 70, 30));
    runUntil(s, () => hunter.state === 2, 200);
    expect(hunter.state).toBe(2);
    // The prey "escapes" far beyond the leash: the hunter returns.
    prey.path = [];
    prey.x = 21;
    prey.y = 38;
    hunter.cargo = at(s, 118, 2); // post far east: the prey is now > WARSHIP_LEASH from it
    expect(118 - 21).toBeGreaterThan(WARSHIP_LEASH);
    runUntil(s, () => hunter.state !== 2, 100);
    expect(hunter.state).toBe(1);
    expect(hunter.chase).toBe(0);

    const a = seaGame();
    formAlliance(a, 1, 2);
    const h2 = spawnWarshipAt(a, 2, at(a, 119, 2), at(a, 70, 2));
    spawnWarshipAt(a, 1, at(a, 20, 38), at(a, 70, 30));
    runUntil(a, () => h2.state === 2, 200);
    expect(h2.state).not.toBe(2);

    const p = seaGame();
    p.settings.modifiers.peaceMinutes = 10;
    const h3 = spawnWarshipAt(p, 2, at(p, 119, 2), at(p, 70, 2));
    spawnWarshipAt(p, 1, at(p, 20, 38), at(p, 70, 30));
    runUntil(p, () => h3.state === 2, 200);
    expect(h3.state).not.toBe(2);
  });

  it('a new order cancels a chase', () => {
    const s = seaGame();
    const hunter = spawnWarshipAt(s, 2, at(s, 119, 2), at(s, 70, 2));
    spawnWarshipAt(s, 1, at(s, 20, 38), at(s, 70, 30));
    runUntil(s, () => hunter.state === 2, 200);
    expect(applyAction(s, 2, { type: 'moveWarship', unitId: hunter.id, tile: at(s, 100, 5) }).ok).toBe(true);
    expect(hunter.state).toBe(1);
    expect(hunter.chase).toBe(0);
  });
});

describe('warship groups', () => {
  it('moves several own warships to distinct water tiles around the click', () => {
    const s = seaGame();
    const g = [0, 1, 2, 3].map((k) => spawnWarshipAt(s, 1, at(s, 19, 20), at(s, 25, 10 + k * 3)));
    const target = at(s, 60, 20);
    expect(applyAction(s, 1, { type: 'moveWarships', unitIds: g.map((u) => u.id), tile: target }).ok).toBe(true);
    const ends = g.map((u) => u.target);
    expect(new Set(ends).size).toBe(4);
    for (const t of ends) expect(isWater(s.map.terrain[t])).toBe(true);
    for (const u of g) expect(u.state).toBe(1);
    runUntil(s, () => g.every((u) => u.state === 0), 1000);
    for (const u of g) expect(Math.abs(u.x - 60) + Math.abs(u.y - 20)).toBeLessThan(12);
  });

  it('refuses foreign, duplicate, empty and oversized lists, and land targets', () => {
    const s = seaGame();
    const mine = spawnWarshipAt(s, 1, at(s, 19, 20), at(s, 25, 10));
    const theirs = spawnWarshipAt(s, 2, at(s, 120, 20), at(s, 115, 10));
    const move = (ids: number[], tile = at(s, 60, 20)) => applyAction(s, 1, { type: 'moveWarships', unitIds: ids, tile });
    expect(move([mine.id, theirs.id]).ok).toBe(false);
    expect(move([mine.id, mine.id]).ok).toBe(false);
    expect(move([]).ok).toBe(false);
    expect(move(Array.from({ length: 65 }, (_, k) => k + 1)).ok).toBe(false);
    expect(move([mine.id], at(s, 5, 20)).ok).toBe(false);
    expect(theirs.state).toBe(0);
  });

  it('formation slots are distinct and pass the filter', () => {
    const s = seaGame();
    const t = formationTiles(s, at(s, 60, 20), 9, (x) => isWater(s.map.terrain[x]));
    expect(t.length).toBe(9);
    expect(new Set(t).size).toBe(9);
    expect(t[0]).toBe(at(s, 60, 20));
  });

  it('is deterministic: identical games with the same orders hash the same', () => {
    const run = (): number => {
      const s = seaGame(11);
      const port = addBuilding(s, 'port', 1, at(s, 19, 20));
      applyAction(s, 1, { type: 'buildWarship', port: port.tile, tile: at(s, 30, 20) });
      const g = [0, 1, 2].map((k) => spawnWarshipAt(s, 1, at(s, 19, 20), at(s, 25, 10 + k * 3)));
      spawnWarshipAt(s, 2, at(s, 119, 2), at(s, 90, 20));
      step(s, 30);
      applyAction(s, 1, { type: 'moveWarships', unitIds: g.map((u) => u.id), tile: at(s, 80, 20) });
      step(s, 400);
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});
