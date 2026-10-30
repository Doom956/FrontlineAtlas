// Levels of SAMs / silos / forts, paratroopers, artillery barrages, public army sizes, the advisor's hints.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { MAX_SUGGESTIONS, suggestions } from '../src/sim/advisor';
import { artilleryOf, barrageKill, barrageRange, canBarrage } from '../src/sim/barrage';
import {
  aircraftCap,
  armyTotalOf,
  chargesReady,
  fortMultiplierAt,
  fortRadius,
  hasIntel,
  isFortified,
  markBuildingsChanged,
  nextChargeIn,
  samRadius,
} from '../src/sim/buildings';
import {
  AIRCRAFT_MAX_PER_AIRFIELD,
  BARRAGE_BUILDING_DAMAGE,
  BARRAGE_COOLDOWN,
  BARRAGE_COOLDOWN_BALLISTICS,
  BARRAGE_DELAY,
  BARRAGE_DISABLE_SECONDS,
  BARRAGE_GOLD,
  BARRAGE_KILL_ARMY_SHARE,
  BARRAGE_KILL_MAX,
  BARRAGE_MIN_ARTILLERY,
  BARRAGE_RANGE,
  BUILDINGS,
  FORT_DEFENSE,
  FORT_LEVEL_DEFENSE,
  FORT_LEVEL_RADIUS,
  PARADROP_COOLDOWN,
  PARADROP_RANGE,
  PARADROP_RANGE_PER_LEVEL,
  SAM_COOLDOWN,
  SAM_LEVEL_RADIUS,
  SILO_COOLDOWN,
  TICKS_PER_SECOND,
  UNITS,
} from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { canParadrop, paradropMaxTroops, paradropRange, updateUnits } from '../src/sim/units';
import { updateBarrages } from '../src/sim/barrage';
import type { Building, BuildingType, GameState, TechId, Troops, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });

/** 220x40 plains: player 1 owns x 0..59, player 2 owns x 60..219 (capital at 120, 20). Both rich. */
function landGame(players = 2): GameState {
  const s = makeFlatGame(220, 40, players, { human: true, seed: 3 });
  claimRect(s, 1, 0, 0, 59, 39);
  claimRect(s, 2, 60, 0, 219, 39);
  s.players[1].capital = at(s, 10, 20);
  s.players[2].capital = at(s, 120, 20);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.maxPop = 1e6;
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
function giveTech(s: GameState, id: number, ...techs: TechId[]): void {
  s.players[id].techs.push(...techs);
}
/** Ticks units and barrages until pred() holds (or maxTicks). */
function runUntil(s: GameState, pred: () => boolean, maxTicks = 3000): number {
  let k = 0;
  for (; k < maxTicks && !pred(); k++) {
    updateUnits(s);
    updateBarrages(s);
    s.tick++;
  }
  return k;
}
const unitsOf = (s: GameState, type: Unit['type']): Unit[] => s.units.filter((u) => u.type === type);

describe('levels: forts, SAMs, silos, airfields', () => {
  it('forts reach further and defend more per level; a barrage-disabled fort gives nothing', () => {
    const s = landGame();
    const fort = addBuilding(s, 'fort', 2, at(s, 80, 20), 3);
    expect(fortRadius(s, fort)).toBe(BUILDINGS.fort.radius + 2 * FORT_LEVEL_RADIUS);
    expect(fortMultiplierAt(s, at(s, 80 - 26, 20), 2)).toBeCloseTo(FORT_DEFENSE + 2 * FORT_LEVEL_DEFENSE);
    expect(fortMultiplierAt(s, at(s, 80 + 26, 20), 2)).toBeCloseTo(FORT_DEFENSE + 2 * FORT_LEVEL_DEFENSE);
    expect(fortMultiplierAt(s, at(s, 80 + 27, 20), 2)).toBe(1);
    fort.disabledUntil = s.tick + 10;
    expect(fortMultiplierAt(s, at(s, 80, 20), 2)).toBe(1);
    expect(isFortified(s, at(s, 80, 20), 2)).toBe(false);
    s.tick += 10;
    expect(isFortified(s, at(s, 80, 20), 2)).toBe(true);
  });

  it('a level-L SAM holds L shots and reloads them L times as fast; reach grows', () => {
    const s = landGame();
    giveTech(s, 1, 'flight');
    const sam = addBuilding(s, 'sam', 2, at(s, 100, 20), 2);
    expect(samRadius(sam)).toBe(BUILDINGS.sam.radius + SAM_LEVEL_RADIUS);
    expect(chargesReady(sam)).toBe(2);
    // Two bombers arrive together: both shot down in one salvo.
    const af = addBuilding(s, 'airfield', 1, at(s, 30, 20));
    af.bombers = 3;
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 100, 10) }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 100, 30) }).ok).toBe(true);
    runUntil(s, () => unitsOf(s, 'bomber').length === 0, 300);
    expect(chargesReady(sam)).toBe(0);
    expect(af.bombers).toBe(1);
    // Reload: one shot back after SAM_COOLDOWN / level.
    expect(nextChargeIn(sam)).toBeLessThanOrEqual(SAM_COOLDOWN / 2 + 1e-9);
    runUntil(s, () => chargesReady(sam) === 2, 1000);
    expect(chargesReady(sam)).toBe(2);
    // Saturation: a level-1 SAM against two bombers lets one through.
    const t = landGame();
    giveTech(t, 1, 'flight');
    const one = addBuilding(t, 'sam', 2, at(t, 100, 20));
    const af2 = addBuilding(t, 'airfield', 1, at(t, 30, 20));
    af2.bombers = 2;
    applyAction(t, 1, { type: 'bomb', airfield: af2.tile, tile: at(t, 100, 10) });
    applyAction(t, 1, { type: 'bomb', airfield: af2.tile, tile: at(t, 100, 30) });
    runUntil(t, () => unitsOf(t, 'bomber').every((u) => u.state === 1) || unitsOf(t, 'bomber').length === 0, 400);
    expect(t.events.some((e) => e.kind === 'bombing')).toBe(true);
    expect(t.events.filter((e) => e.kind === 'unitLost').length).toBe(1);
    expect(one.level).toBe(1);
  });

  it('a level-2 silo launches twice, then reloads', () => {
    const s = landGame();
    giveTech(s, 1, 'rocketry');
    const silo = addBuilding(s, 'silo', 1, at(s, 10, 10), 2);
    expect(applyAction(s, 1, { type: 'launchMissile', silo: silo.tile, kind: 'rocket', tile: at(s, 100, 20) }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'launchMissile', silo: silo.tile, kind: 'rocket', tile: at(s, 110, 20) }).ok).toBe(true);
    const r = applyAction(s, 1, { type: 'launchMissile', silo: silo.tile, kind: 'rocket', tile: at(s, 120, 20) });
    expect(r.reason).toMatch(/reloading/);
    expect(nextChargeIn(silo)).toBeCloseTo(SILO_COOLDOWN / 2, 6);
  });

  it('an airfield holds more aircraft per level', () => {
    const s = landGame();
    const af = addBuilding(s, 'airfield', 1, at(s, 10, 10), 3);
    expect(aircraftCap(af)).toBe(3 * AIRCRAFT_MAX_PER_AIRFIELD);
    giveTech(s, 1, 'flight');
    for (let k = 0; k < aircraftCap(af); k++) expect(applyAction(s, 1, { type: 'buildAircraft', airfield: af.tile, kind: 'fighter' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'buildAircraft', airfield: af.tile, kind: 'fighter' }).ok).toBe(false);
  });
});

describe('paratroopers', () => {
  function dropGame(): { s: GameState; af: Building } {
    const s = landGame();
    giveTech(s, 1, 'flight');
    s.players[1].troops = inf(200000);
    s.players[2].troops = inf(20000);
    const af = addBuilding(s, 'airfield', 1, at(s, 50, 20));
    return { s, af };
  }

  it('checks tech, airfield, range, target, troops and money', () => {
    const { s, af } = dropGame();
    const target = at(s, 100, 20);
    expect(paradropRange(af)).toBe(PARADROP_RANGE);
    expect(canParadrop(s, 1, af.tile, target, 5000).ok).toBe(true);
    const beyond = at(s, 50 + PARADROP_RANGE + 2, 20);
    expect(canParadrop(s, 1, af.tile, beyond, 5000).reason).toMatch(/Too far/);
    af.level = 2;
    expect(paradropRange(af)).toBe(PARADROP_RANGE + PARADROP_RANGE_PER_LEVEL);
    expect(canParadrop(s, 1, af.tile, beyond, 5000).ok).toBe(true);
    af.level = 1;
    expect(canParadrop(s, 1, af.tile, at(s, 20, 20), 5000).reason).toMatch(/own land/);
    expect(canParadrop(s, 1, af.tile, target, 10).reason).toMatch(/at least/);
    const max = paradropMaxTroops(s, 1, af);
    expect(canParadrop(s, 1, af.tile, target, max + 1).reason).toMatch(/At most/);
    expect(canParadrop(s, 1, at(s, 10, 10), target, 5000).reason).toMatch(/Airfield/);
    s.players[1].techs = [];
    expect(canParadrop(s, 1, af.tile, target, 5000).reason).toMatch(/Flight/);
    giveTech(s, 1, 'flight');
    s.players[1].gold = 0;
    expect(canParadrop(s, 1, af.tile, target, 5000).reason).toMatch(/gold/);
    s.players[1].gold = 1e6;
    formAlliance(s, 1, 2);
    expect(canParadrop(s, 1, af.tile, target, 5000).reason).toMatch(/ally/);
  });

  it('flies, warns the target, lands and attacks from the drop tile', () => {
    const { s, af } = dropGame();
    const target = at(s, 100, 20);
    const army = armyTotalOf(s, 1);
    expect(applyAction(s, 1, { type: 'paradrop', airfield: af.tile, tile: target, troops: 8000 }).ok).toBe(true);
    expect(s.players[1].troops.infantry).toBe(200000 - 8000);
    expect(s.players[1].gold).toBe(1e6 - UNITS.transportPlane.gold);
    expect(af.dropCooldown).toBe(PARADROP_COOLDOWN);
    expect(armyTotalOf(s, 1)).toBeCloseTo(army, 6); // in the air, still part of the army
    expect(s.events.some((e) => e.kind === 'paradrop' && e.players.includes(2))).toBe(true);
    expect(applyAction(s, 1, { type: 'paradrop', airfield: af.tile, tile: target, troops: 8000 }).reason).toMatch(/next drop/);
    const [plane] = unitsOf(s, 'transportPlane');
    expect(troopSum(plane.troops)).toBe(8000);
    runUntil(s, () => unitsOf(s, 'transportPlane').length === 0, 200);
    expect(s.map.owner[target]).toBe(1);
    const a = s.attacks.find((q) => q.attacker === 1 && q.target === 2);
    expect(a?.amphibious).toBe(true);
    expect(troopSum(a!.troops)).toBeGreaterThan(0);
    expect(troopSum(a!.troops)).toBeLessThan(8000);
  });

  it('comes home when the drop tile became own land', () => {
    const { s, af } = dropGame();
    const target = at(s, 100, 20);
    applyAction(s, 1, { type: 'paradrop', airfield: af.tile, tile: target, troops: 8000 });
    s.map.owner[target] = 1;
    runUntil(s, () => unitsOf(s, 'transportPlane').length === 0, 200);
    expect(s.players[1].troops.infantry).toBe(200000);
  });

  it('a SAM shoots the cargo plane down: the paratroopers are lost', () => {
    const { s, af } = dropGame();
    addBuilding(s, 'sam', 2, at(s, 95, 20));
    applyAction(s, 1, { type: 'paradrop', airfield: af.tile, tile: at(s, 100, 20), troops: 8000 });
    runUntil(s, () => unitsOf(s, 'transportPlane').length === 0, 200);
    expect(s.attacks.length).toBe(0);
    expect(s.players[1].stats.troopsLost).toBe(8000);
    expect(s.players[2].stats.troopsKilled).toBe(8000);
    expect(s.events.some((e) => e.kind === 'unitLost' && /paratroopers/.test(e.message))).toBe(true);
  });

  it('fighters intercept cargo planes; a barrage-silenced SAM does not fire', () => {
    const { s, af } = dropGame();
    const enemyField = addBuilding(s, 'airfield', 2, at(s, 110, 20));
    enemyField.fighters = 2;
    applyAction(s, 1, { type: 'paradrop', airfield: af.tile, tile: at(s, 100, 20), troops: 8000 });
    runUntil(s, () => unitsOf(s, 'transportPlane').length === 0, 200);
    expect(s.attacks.length).toBe(0);
    const t = dropGame();
    const sam = addBuilding(t.s, 'sam', 2, at(t.s, 95, 20));
    sam.disabledUntil = t.s.tick + 1000;
    applyAction(t.s, 1, { type: 'paradrop', airfield: t.af.tile, tile: at(t.s, 100, 20), troops: 8000 });
    runUntil(t.s, () => unitsOf(t.s, 'transportPlane').length === 0, 200);
    expect(t.s.map.owner[at(t.s, 100, 20)]).toBe(1);
  });
});

describe('artillery barrage', () => {
  function gunGame(): GameState {
    const s = landGame();
    s.players[1].troops = { infantry: 50000, armor: 0, artillery: 10000 };
    s.players[2].troops = inf(1e6);
    return s;
  }

  it('checks artillery, reload, range from the border, target and gold', () => {
    const s = gunGame();
    expect(artilleryOf(s, 1)).toBe(10000);
    expect(barrageRange(s.players[1])).toBe(BARRAGE_RANGE);
    expect(canBarrage(s, 1, at(s, 60 + BARRAGE_RANGE - 1, 20)).ok).toBe(true);
    expect(canBarrage(s, 1, at(s, 60 + BARRAGE_RANGE + 1, 20)).reason).toMatch(/Too far/);
    giveTech(s, 1, 'ballistics');
    expect(canBarrage(s, 1, at(s, 60 + BARRAGE_RANGE + 1, 20)).ok).toBe(true);
    expect(canBarrage(s, 1, at(s, 30, 20)).reason).toMatch(/own land/);
    s.players[1].troops.artillery = BARRAGE_MIN_ARTILLERY - 1;
    expect(canBarrage(s, 1, at(s, 65, 20)).reason).toMatch(/artillery/);
    s.players[1].troops.artillery = 10000;
    s.players[1].gold = BARRAGE_GOLD - 1;
    expect(canBarrage(s, 1, at(s, 65, 20)).reason).toMatch(/gold/);
    s.players[1].gold = 1e6;
    formAlliance(s, 1, 2);
    expect(canBarrage(s, 1, at(s, 65, 20)).reason).toMatch(/ally/);
  });

  it('is telegraphed, then kills troops, silences forts and SAMs, and never moves the front', () => {
    const s = gunGame();
    const fort = addBuilding(s, 'fort', 2, at(s, 70, 20));
    const sam = addBuilding(s, 'sam', 2, at(s, 72, 22));
    const shop = addBuilding(s, 'market', 2, at(s, 140, 20)); // far away: untouched
    const owners = s.map.owner.slice();
    expect(applyAction(s, 1, { type: 'barrage', tile: at(s, 71, 21) }).ok).toBe(true);
    expect(s.players[1].gold).toBe(1e6 - BARRAGE_GOLD);
    expect(s.barrages.length).toBe(1);
    expect(s.barrages[0].hitTick).toBe(s.tick + BARRAGE_DELAY * TICKS_PER_SECOND);
    expect(s.events.some((e) => e.kind === 'barrage' && e.players.includes(2))).toBe(true);
    expect(applyAction(s, 1, { type: 'barrage', tile: at(s, 65, 20) }).reason).toMatch(/reloading/);
    // Nothing happens before the shells land.
    for (let k = 0; k < BARRAGE_DELAY * TICKS_PER_SECOND; k++) {
      updateBarrages(s);
      s.tick++;
    }
    expect(s.players[2].troops.infantry).toBe(1e6);
    expect(isFortified(s, at(s, 70, 20), 2)).toBe(true);
    updateBarrages(s);
    expect(s.barrages.length).toBe(0);
    const killed = 1e6 - s.players[2].troops.infantry;
    expect(killed).toBeCloseTo(Math.min(barrageKill(10000), BARRAGE_KILL_ARMY_SHARE * 1e6), 6);
    expect(fort.hp).toBeCloseTo(1 - BARRAGE_BUILDING_DAMAGE, 9);
    expect(sam.hp).toBeCloseTo(1 - BARRAGE_BUILDING_DAMAGE, 9);
    expect(fortMultiplierAt(s, at(s, 70, 20), 2)).toBe(1);
    expect(isFortified(s, at(s, 70, 20), 2)).toBe(false);
    expect(s.map.owner).toEqual(owners);
    expect(s.effects.some((e) => e.kind === 'barrage')).toBe(true);
    expect(s.buildings.has(shop.id)).toBe(true);
    // The fort is back after BARRAGE_DISABLE_SECONDS.
    s.tick += BARRAGE_DISABLE_SECONDS * TICKS_PER_SECOND;
    expect(isFortified(s, at(s, 70, 20), 2)).toBe(true);
    // Reload: BARRAGE_COOLDOWN, shorter with Ballistics.
    expect(s.players[1].barrageReadyTick).toBe(BARRAGE_COOLDOWN * TICKS_PER_SECOND);
    giveTech(s, 1, 'ballistics');
    applyAction(s, 1, { type: 'barrage', tile: at(s, 65, 20) });
    expect(s.players[1].barrageReadyTick - s.tick).toBe(BARRAGE_COOLDOWN_BALLISTICS * TICKS_PER_SECOND);
  });

  it('a silenced SAM lets a bomber through; repeated shelling destroys a fort', () => {
    const s = gunGame();
    giveTech(s, 1, 'flight');
    const sam = addBuilding(s, 'sam', 2, at(s, 75, 20));
    applyAction(s, 1, { type: 'barrage', tile: at(s, 75, 20) });
    runUntil(s, () => s.barrages.length === 0, 50);
    expect(sam.disabledUntil).toBeGreaterThan(s.tick);
    const af = addBuilding(s, 'airfield', 1, at(s, 40, 20));
    af.bombers = 1;
    applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 90, 20) });
    runUntil(s, () => s.events.some((e) => e.kind === 'bombing'), 300);
    expect(s.events.some((e) => e.kind === 'bombing')).toBe(true);
    expect(s.events.some((e) => e.kind === 'unitLost')).toBe(false);
    // Shelling it again and again (faster than it repairs) takes a fort down.
    const t = gunGame();
    const fort = addBuilding(t, 'fort', 2, at(t, 66, 20));
    for (let k = 0; k < 5; k++) {
      t.players[1].barrageReadyTick = 0;
      expect(applyAction(t, 1, { type: 'barrage', tile: fort.tile }).ok).toBe(true);
      runUntil(t, () => t.barrages.length === 0, 50);
    }
    expect(t.buildings.has(fort.id)).toBe(false);
  });

  it('kills more with more artillery, with diminishing returns', () => {
    expect(barrageKill(0)).toBe(0);
    expect(barrageKill(20000)).toBeGreaterThan(barrageKill(10000));
    expect(barrageKill(20000) / barrageKill(10000)).toBeLessThan(2);
    expect(barrageKill(1e9)).toBeLessThan(BARRAGE_KILL_MAX + 1e-6);
  });
});

describe('public army sizes', () => {
  it('armyTotalOf counts home, attacks and troops in transit; intel only gates the mix', () => {
    const s = landGame();
    s.players[2].troops = { infantry: 1000, armor: 500, artillery: 200 };
    s.attacks.push({ id: 99, attacker: 2, target: 1, troops: inf(300), focusTile: 0, progress: 0, startTick: 0, amphibious: false, losses: 0, tilesTaken: 0 });
    expect(armyTotalOf(s, 2)).toBe(2000);
    expect(hasIntel(s, 1, 2)).toBe(false); // the total is public anyway
  });
});

describe('advisor hints', () => {
  it('suggests plain next steps, most urgent first, at most MAX_SUGGESTIONS, without changing the state', () => {
    const s = landGame(3);
    claimRect(s, 3, 60, 0, 70, 5); // a small third nation
    s.players[1].troops = inf(900000); // nearly full
    const before = hashState(s);
    const hints = suggestions(s, 1);
    expect(hashState(s)).toBe(before);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    for (let k = 1; k < hints.length; k++) expect(hints[k - 1].priority).toBeGreaterThanOrEqual(hints[k].priority);
    expect(hints.some((h) => h.id === 'build-city' && h.building === 'city' && typeof h.tile === 'number')).toBe(true);
    expect(hints.some((h) => h.id === 'full-attack')).toBe(true);
    expect(suggestions(s, 1)).toEqual(hints); // deterministic
    // With a city and gold: no "build a city" hint first.
    addBuilding(s, 'city', 1, at(s, 10, 20));
    expect(suggestions(s, 1).some((h) => h.id === 'build-city' && h.priority >= 85)).toBe(false);
  });

  it('points at a weak tribe, an attacker, a fort to shell', () => {
    const s = makeFlatGame(100, 40, 3, { human: true, seed: 5 });
    claimRect(s, 1, 0, 0, 49, 39);
    claimRect(s, 2, 50, 0, 99, 19);
    claimRect(s, 3, 50, 20, 99, 39);
    s.players[3].personality = 'tribe';
    s.players[1].troops = { infantry: 100000, armor: 0, artillery: 5000 };
    s.players[1].maxPop = 1e6;
    s.players[2].troops = inf(100000);
    s.players[3].troops = inf(2000);
    addBuilding(s, 'fort', 2, at(s, 55, 10));
    s.attacks.push({ id: 77, attacker: 2, target: 1, troops: inf(5000), focusTile: at(s, 49, 10), progress: 0, startTick: 0, amphibious: false, losses: 0, tilesTaken: 0 });
    const ids = suggestions(s, 1).map((h) => h.id);
    expect(ids[0]).toBe('counter-2');
    expect(ids).toContain('attack-tribe-3');
    expect(ids).toContain('barrage');
  });

  it('warns of a neighbour army far bigger than the home troops, and says not to counter a bigger attack', () => {
    const s = makeFlatGame(100, 40, 2, { human: true, seed: 5 });
    claimRect(s, 1, 0, 0, 49, 39);
    claimRect(s, 2, 50, 0, 99, 39);
    s.players[1].troops = inf(20000);
    s.players[1].maxPop = 1e6;
    s.players[2].troops = inf(100000);
    const danger = suggestions(s, 1).find((h) => h.id === 'danger-2');
    expect(danger?.text).toMatch(/^DANGER: .*5x your home troops/);
    expect(danger?.building).toBe('fort');
    s.attacks.push({ id: 78, attacker: 2, target: 1, troops: inf(60000), focusTile: at(s, 49, 10), progress: 0, startTick: 0, amphibious: false, losses: 0, tilesTaken: 0 });
    const ids = suggestions(s, 1).map((h) => h.id);
    expect(ids[0]).toBe('defend-2');
    expect(ids).not.toContain('counter-2');
  });
});

describe('abilities are deterministic', () => {
  function scripted(): number[] {
    const s = landGame();
    giveTech(s, 1, 'flight');
    s.players[1].troops = { infantry: 200000, armor: 0, artillery: 20000 };
    s.players[2].troops = inf(50000);
    const af = addBuilding(s, 'airfield', 1, at(s, 50, 20), 2);
    addBuilding(s, 'fort', 2, at(s, 68, 20));
    addBuilding(s, 'sam', 2, at(s, 140, 20));
    const hashes: number[] = [];
    for (let k = 0; k < 400; k++) {
      if (k === 5) applyAction(s, 1, { type: 'barrage', tile: at(s, 68, 20) });
      if (k === 10) applyAction(s, 1, { type: 'paradrop', airfield: af.tile, tile: at(s, 110, 20), troops: 15000 });
      if (k === 40) applyAction(s, 1, { type: 'attack', tile: at(s, 60, 20), troops: inf(30000) });
      tick(s);
      if (k % 50 === 0) hashes.push(hashState(s));
    }
    return hashes;
  }
  it('two games with the same paradrop and barrage orders hash the same', () => {
    expect(scripted()).toEqual(scripted());
  });
});
