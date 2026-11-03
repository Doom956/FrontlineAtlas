// Auto for every vehicle: a player's war target also comes from defence and stays while the war is live; new
// divisions support the war, new airfields fly Support (or the "every airfield" choice), silos auto-fire; wings and
// divisions find an aim they can reach; wars overseas give wings and rockets a coast to aim at.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { wingOf } from '../src/sim/airwings';
import { autoFireAll } from '../src/sim/airstrike';
import { markBuildingsChanged } from '../src/sim/buildings';
import { frontTiles } from '../src/sim/combat';
import { TANK_MOBILITY, TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { buildAircraft } from '../src/sim/units';
import { followedNation, liveFoes, mainFront, warAim } from '../src/sim/warTarget';
import { Terrain } from '../src/sim/types';
import type { Attack, Building, BuildingType, GameState } from '../src/sim/types';
import { airAutoLine, siloAutoLine, unitAutoLine } from '../src/client/follow';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
const run = (s: GameState, n: number): void => {
  for (let k = 0; k < n; k++) tick(s);
};
const SEC = TICKS_PER_SECOND;

function rich(s: GameState): void {
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.troops = { infantry: p.id === 1 ? 400000 : 200000, armor: 0, artillery: 0 };
  }
  s.players[1].techs.push('flight', 'navigation', 'mechanization', 'rocketry');
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** An attack record of `attacker` on `target` (as the attack action would make, without spending troops). */
function pushAttack(s: GameState, attacker: number, target: number, focus: number, troops = 20000): void {
  const a: Attack = { id: 800 + s.attacks.length, attacker, target, troops: { infantry: troops, armor: 0, artillery: 0 }, focusTile: focus, progress: 0, startTick: s.tick, amphibious: false, losses: 0, tilesTaken: 0 };
  s.attacks.push(a);
}
/** pid and `other` stay at war (state.warMemory) without an attack running. */
function longWar(s: GameState, a: number, b: number): void {
  (s.warMemory ??= []).push(Math.min(a, b), Math.max(a, b), 1e9);
}

/** 120 x 40 land: AI 2 x 0..39, the player 1 x 40..79, AI 3 x 80..119. */
function strip(seed = 5): GameState {
  const s = makeFlatGame(120, 40, 3, { human: true, seed });
  claimRect(s, 2, 0, 0, 39, 39);
  claimRect(s, 1, 40, 0, 79, 39);
  claimRect(s, 3, 80, 0, 119, 39);
  rich(s);
  return s;
}

/**
 * Own land in two pieces: A (x 0..29, y 0..19) and B (x 60..89, y 0..19, the capital's); nation 3 between them (x
 * 30..59, y 0..19), nation 2 east of B (x 90..119, y 0..19) and under A and 3 (x 0..59, y 20..39); sea under B.
 */
function split(): GameState {
  const s = makeFlatGame(120, 40, 3, { human: true, seed: 9 });
  for (let y = 20; y < 40; y++) for (let x = 60; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 29, 19);
  claimRect(s, 3, 30, 0, 59, 19);
  claimRect(s, 1, 60, 0, 89, 19);
  claimRect(s, 2, 90, 0, 119, 19);
  claimRect(s, 2, 0, 20, 59, 39);
  s.players[1].capital = at(s, 75, 10);
  rich(s);
  return s;
}

describe('war target from defence', () => {
  it('a player that only defends follows the nation attacking it; a nation beats a tribe attack of its own', () => {
    const s = makeFlatGame(120, 40, 4, { human: true, seed: 5 });
    claimRect(s, 2, 0, 0, 39, 39);
    claimRect(s, 1, 40, 0, 79, 39);
    claimRect(s, 3, 80, 0, 119, 39);
    claimRect(s, 4, 76, 32, 83, 39); // a tribe between 1 and 3
    rich(s);
    s.players[4].personality = 'tribe';
    expect(followedNation(s, 1)).toBe(0);
    pushAttack(s, 2, 1, at(s, 40, 20));
    run(s, 2 * SEC + 1);
    expect(followedNation(s, 1)).toBe(2);
    expect(s.map.owner[mainFront(s, 1, 2)]).toBe(2);
    // Our own attack on a tribe doesn't pull the war away from the nation invading us.
    pushAttack(s, 1, 4, at(s, 76, 35), 2000);
    for (let k = 0; k < 2 * SEC + 1; k++) {
      tick(s);
      expect(followedNation(s, 1)).toBe(2);
    }
    // Our own attack on a nation wins over the threat.
    pushAttack(s, 1, 3, at(s, 80, 10), 20000);
    run(s, 1);
    expect(followedNation(s, 1)).toBe(3);
    expect(liveFoes(s, 1).slice(0, 2)).toEqual([2, 3]);
  });
});

describe('defaults for a player', () => {
  it('new divisions support the war (AI divisions keep their own modes); rockets auto-fire for players only', () => {
    const s = strip();
    const mine = spawnTankDivision(s, 1, at(s, 60, 20));
    const theirs = spawnTankDivision(s, 2, at(s, 20, 20));
    expect(mine.mode).toBe('support');
    expect(mine.fixed).toBeUndefined();
    expect(theirs.mode).toBeUndefined();
    expect(autoFireAll(s, 1)).toBe(true);
    expect(autoFireAll(s, 2)).toBe(false);
    // With a war it takes up the front by itself.
    pushAttack(s, 1, 3, at(s, 80, 20), 50000);
    run(s, 4 * SEC);
    expect(mine.station).toBeDefined();
    expect(s.map.owner[mine.station!]).toBe(3);
  });

  it('new airfields fly Support following the war; "every airfield" choices reach airfields built later', () => {
    const s = strip();
    s.players[2].techs.push('flight');
    const a = addBuilding(s, 'airfield', 1, at(s, 60, 10), 2);
    const enemy = addBuilding(s, 'airfield', 2, at(s, 20, 10), 2);
    run(s, SEC + 1);
    expect(wingOf(s, a)).toMatchObject({ mission: 'support', follow: true });
    expect(wingOf(s, enemy)).toBeUndefined();
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: -1, mission: 'superiority' }).ok).toBe(true);
    const b = addBuilding(s, 'airfield', 1, at(s, 70, 30), 1);
    run(s, SEC + 1);
    expect(wingOf(s, b)?.mission).toBe('superiority');
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: -1, mission: 'idle', refill: true }).ok).toBe(true);
    const c = addBuilding(s, 'airfield', 1, at(s, 50, 30), 1);
    run(s, SEC + 1);
    expect(wingOf(s, c)).toMatchObject({ mission: 'idle', refill: true });
    expect(airAutoLine(s, c)).toBe('Auto: off (Idle)');
  });
});

describe('aims in reach', () => {
  it('a following wing whose main front is out of reach bombs the war target where it can reach', () => {
    // 400 x 40: nation 2 y 0..19, the player y 20..39, a border 400 tiles long; the attack is at the far end.
    const s = makeFlatGame(400, 40, 2, { human: true, seed: 3 });
    claimRect(s, 2, 0, 0, 399, 19);
    claimRect(s, 1, 0, 20, 399, 39);
    rich(s);
    const af = addBuilding(s, 'airfield', 1, at(s, 20, 30), 1);
    for (let k = 0; k < 4; k++) expect(buildAircraft(s, 1, af.tile, 'bomber').ok).toBe(true);
    pushAttack(s, 1, 2, at(s, 380, 19), 50000);
    run(s, 2 * SEC + 1);
    const front = mainFront(s, 1, 2);
    expect(front % s.map.width).toBeGreaterThan(300);
    let launched = -1;
    for (let k = 0; k < 20 * SEC && launched < 0; k++) {
      tick(s);
      const b = s.units.find((u) => u.type === 'bomber' && u.owner === 1);
      if (b) launched = b.target;
    }
    expect(launched).toBeGreaterThanOrEqual(0);
    expect(s.map.owner[launched]).toBe(2);
    const dx = (launched % 400) - 20;
    const dy = ((launched / 400) | 0) - 30;
    expect(dx * dx + dy * dy).toBeLessThanOrEqual(150 * 150);
    expect(airAutoLine(s, af)).toMatch(/^Auto: bombing the front with /);
  });

  it('a division that cannot reach the main front over its land supports a front it can reach', () => {
    const s = split();
    longWar(s, 1, 3);
    pushAttack(s, 1, 2, at(s, 90, 10), 50000);
    run(s, 2 * SEC + 1);
    expect(followedNation(s, 1)).toBe(2);
    const u = spawnTankDivision(s, 1, at(s, 5, 10));
    // The main front (in B) can't be reached from A: the division takes the border with 2 that A touches.
    let ok = false;
    for (let k = 0; k < 10 * SEC && !ok; k++) {
      tick(s);
      ok = u.detour !== undefined;
    }
    expect(ok).toBe(true);
    expect(u.detour).toBeGreaterThan(s.tick);
    expect(s.map.owner[u.station!]).toBe(2);
    expect(((u.station! / s.map.width) | 0)).toBe(20);
    expect(u.station! % s.map.width).toBeLessThan(30);
    expect(u.state).toBe(1);
    expect(unitAutoLine(s, 1, u)).toBe(`Auto: driving to the front with ${s.players[2].name}`);
  });

  it('a far drive the quick search gives up on still finds its route over our land', () => {
    const s = strip(11);
    const budget = TANK_MOBILITY.jumpBudget;
    (TANK_MOBILITY as { jumpBudget: number }).jumpBudget = 10;
    try {
      const u = spawnTankDivision(s, 1, at(s, 78, 2));
      pushAttack(s, 1, 2, at(s, 39, 38), 50000);
      let driving = false;
      for (let k = 0; k < 8 * SEC && !driving; k++) {
        tick(s);
        driving = u.state === 1 && u.path.length > 10;
      }
      expect(driving).toBe(true);
      expect(u.detour).toBeUndefined();
      expect(s.map.owner[u.path[u.path.length - 1]]).toBe(1);
    } finally {
      (TANK_MOBILITY as { jumpBudget: number }).jumpBudget = budget;
    }
  });
});

describe('a war overseas', () => {
  /** The player x 0..49 (nation 3 y 0..5 above it), sea x 50..69, nation 2 x 70..119; war target 2 across the sea. */
  function overseas(): GameState {
    const s = makeFlatGame(120, 40, 3, { human: true, seed: 4 });
    for (let y = 0; y < 40; y++) for (let x = 50; x < 70; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 6, 49, 39);
    claimRect(s, 3, 0, 0, 49, 5);
    claimRect(s, 2, 70, 0, 119, 39);
    rich(s);
    longWar(s, 1, 2);
    longWar(s, 1, 3);
    // the war target, as a past attack across the sea left it (focus on our coast)
    s.follow!.targets = [1, 2, at(s, 49, 20), 0, -1];
    return s;
  }

  it('wings and rockets aim at the coast nearest the war; divisions support the land front of another war', () => {
    const s = overseas();
    run(s, 2 * SEC + 1);
    expect(followedNation(s, 1)).toBe(2);
    expect(mainFront(s, 1, 2)).toBe(-1);
    const aim = warAim(s, 1, 2);
    expect(s.map.owner[aim]).toBe(2);
    expect(aim % s.map.width).toBe(70);
    // Air support flies at that coast.
    const af = addBuilding(s, 'airfield', 1, at(s, 40, 20), 1);
    for (let k = 0; k < 3; k++) expect(buildAircraft(s, 1, af.tile, 'bomber').ok).toBe(true);
    // A rocket for the city on that coast.
    const city = addBuilding(s, 'city', 2, at(s, 75, 20), 2);
    addBuilding(s, 'silo', 1, at(s, 30, 30), 1);
    const u = spawnTankDivision(s, 1, at(s, 25, 25));
    let bomb = -1;
    let rocket = -1;
    for (let k = 0; k < 15 * SEC && (bomb < 0 || rocket < 0); k++) {
      tick(s);
      const b = s.units.find((q) => q.type === 'bomber' && q.owner === 1);
      if (b && bomb < 0) bomb = b.target;
      const r = s.units.find((q) => q.type === 'rocket' && q.owner === 1);
      if (r && rocket < 0) rocket = r.target;
    }
    expect(s.map.owner[bomb]).toBe(2);
    expect(rocket).toBe(city.tile);
    expect(u.station).toBeDefined();
    expect(s.map.owner[u.station!]).toBe(3);
    expect(frontTiles(s, 1, 3)).toContain(u.station!);
  });
});

describe('determinism', () => {
  it('two identical games with the new defaults give the same hash; the hash covers the new state', () => {
    const play = (): GameState => {
      const s = split();
      s.admin!.aiFrozen = false;
      longWar(s, 1, 3);
      const af = addBuilding(s, 'airfield', 1, at(s, 75, 5), 1);
      for (let k = 0; k < 3; k++) buildAircraft(s, 1, af.tile, 'bomber');
      addBuilding(s, 'silo', 1, at(s, 70, 15), 1);
      addBuilding(s, 'fort', 2, at(s, 95, 10));
      spawnTankDivision(s, 1, at(s, 5, 10));
      spawnTankDivision(s, 1, at(s, 70, 10));
      applyAction(s, 1, { type: 'setAirMission', airfield: -1, mission: 'support', refill: true });
      applyAction(s, 1, { type: 'attack', tile: at(s, 90, 10), troops: { infantry: 50000, armor: 0, artillery: 0 } });
      run(s, 20 * SEC);
      return s;
    };
    const a = play();
    const b = play();
    expect(hashState(a)).toBe(hashState(b));
    expect(a.units.some((u) => u.detour !== undefined)).toBe(true);
    expect(a.air?.defaults?.length).toBe(4);
    const h = hashState(a);
    a.air!.defaults![2] ^= 2;
    expect(hashState(a)).not.toBe(h);
    a.air!.defaults![2] ^= 2;
    const u = a.units.find((q) => q.detour !== undefined)!;
    u.detour! += 1;
    expect(hashState(a)).not.toBe(h);
  });
});

describe('Auto lines', () => {
  it('say what each vehicle does by itself in plain words', () => {
    const s = strip();
    const u = spawnTankDivision(s, 1, at(s, 60, 20));
    const silo = addBuilding(s, 'silo', 1, at(s, 50, 30), 1);
    const af = addBuilding(s, 'airfield', 1, at(s, 60, 10), 1);
    run(s, SEC + 1);
    expect(unitAutoLine(s, 1, u)).toBe('Auto: no war, waiting');
    expect(siloAutoLine(s, silo)).toBe('Auto: no war, waiting');
    expect(airAutoLine(s, af)).toBe('Auto: no bombers here');
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [u.id], mode: 'hold' }).ok).toBe(true);
    expect(unitAutoLine(s, 1, u)).toBe('Auto: off, defends where it is (pick Support)');
    expect(applyAction(s, 1, { type: 'setAutoFire', silo: silo.tile, on: false }).ok).toBe(true);
    expect(siloAutoLine(s, silo)).toMatch(/^Auto: off/);
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [u.id], mode: 'support' }).ok).toBe(true);
    pushAttack(s, 1, 3, at(s, 80, 20), 50000);
    const want = new RegExp(`^Auto: (driving to the front with|supporting the front with|spearhead into) ${s.players[3].name}$`);
    let seen = false;
    for (let k = 0; k < 4 * SEC && !seen; k++) {
      tick(s);
      seen = want.test(unitAutoLine(s, 1, u));
    }
    expect(seen).toBe(true);
  });
});
