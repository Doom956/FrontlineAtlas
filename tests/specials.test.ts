// Special upgrades (specials.ts): Amphibious Tanks, Early Warning, Naval Mines, Drop Tanks, Night Bombing.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { airWingRange, airPatrolRadius } from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { AIR, SPECIALS, TECHS, TECH_ORDER } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import {
  aiSpecialTechs,
  earlyWarningMul,
  isMinedFor,
  mineLandingLoss,
  minefields,
  narrowWater,
  nightDodges,
  nightScatter,
  SPECIAL_TECHS,
} from '../src/sim/specials';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { techStatus, unitVisibleTo } from '../src/sim/techtree';
import { canParadrop, launchBomber, paradropRange, spawnWarshipAt } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, TechId, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

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
function give(s: GameState, id: number, ...techs: TechId[]): void {
  for (const t of techs) if (!s.players[id].techs.includes(t)) s.players[id].techs.push(t);
}
/** Frozen AIs, rich players. */
function prep(s: GameState): GameState {
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
  return s;
}

/** 70x30: land x 0..24 (p1), water x 25..25+gap-1, land beyond (owner `far`: 1 = own island, 2 = enemy). */
function straitGame(gap: number, far: 1 | 2, seed = 4): GameState {
  const s = prep(makeFlatGame(70, 30, 2, { human: true, seed }));
  for (let y = 0; y < 30; y++) for (let x = 25; x < 25 + gap; x++) s.map.terrain[at(s, x, y)] = Terrain.ShallowWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 24, 29);
  claimRect(s, far, 25 + gap, 0, 69, 29);
  if (far === 1) claimRect(s, 2, 64, 0, 69, 3); // p2 keeps a corner (the game must not end)
  s.players[2].capital = at(s, 65, 15);
  give(s, 1, 'mechanization', 'navigation');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
  s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
  return s;
}

describe('special upgrade techs', () => {
  it('five behaviour techs exist, are in the research order and are accepted by the server', () => {
    expect(SPECIAL_TECHS).toEqual(['amphibiousTanks', 'earlyWarning', 'navalMines', 'dropTanks', 'nightBombing']);
    for (const t of SPECIAL_TECHS) {
      expect(TECHS[t].name.length).toBeGreaterThan(3);
      expect(TECHS[t].description.length).toBeGreaterThan(10);
      expect(TECH_ORDER).toContain(t);
      expect(validateAction({ type: 'research', tech: t }).ok).toBe(true);
    }
    expect(TECHS.earlyWarning.requires).toContain('radar');
    const s = straitGame(3, 2);
    expect(techStatus(s, 1, 'amphibiousTanks')).toBe('available');
    expect(techStatus(s, 1, 'earlyWarning')).toBe('locked-prereq');
    expect(applyAction(s, 1, { type: 'research', tech: 'amphibiousTanks' }).ok).toBe(true);
  });
  it('air specials are off when aircraft are off', () => {
    const s = straitGame(3, 2);
    s.settings.modifiers.noAir = true;
    give(s, 1, 'logistics', 'flight');
    expect(techStatus(s, 1, 'dropTanks')).toBe('disabled');
    expect(applyAction(s, 1, { type: 'research', tech: 'nightBombing' }).ok).toBe(false);
  });
});

describe('Amphibious Tanks', () => {
  it('narrow water is a strait of at most amphibMaxWater tiles between two shores', () => {
    const s = straitGame(SPECIALS.amphibMaxWater, 2);
    expect(narrowWater(s, at(s, 27, 10))).toBe(true);
    expect(narrowWater(s, at(s, 10, 10))).toBe(false); // land
    const wide = straitGame(SPECIALS.amphibMaxWater + 3, 2);
    expect(narrowWater(wide, at(wide, 28, 10))).toBe(false);
  });

  it('a division drives across a strait to an own island only with the tech, losing a little on landing', () => {
    const s = straitGame(4, 1);
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    const dest = at(s, 40, 15);
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: dest }).ok).toBe(false);
    give(s, 1, 'amphibiousTanks');
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: dest }).ok).toBe(true);
    const before = troopSum(d.troops);
    let wet = false;
    runUntil(s, () => {
      if (d.wading) wet = true;
      return d.state === 0 && d.x > 30;
    }, 400);
    expect(wet).toBe(true);
    expect(d.hp).toBe(1);
    expect(d.x).toBeGreaterThan(30);
    expect(d.wading).toBeFalsy();
    const lost = before - troopSum(d.troops);
    expect(lost).toBeGreaterThan(before * SPECIALS.amphibLandingLoss * 0.9);
    expect(lost).toBeLessThan(before * SPECIALS.amphibLandingLoss * 1.6);
  });

  it('wide water still stops it', () => {
    const s = straitGame(SPECIALS.amphibMaxWater + 3, 1);
    give(s, 1, 'amphibiousTanks');
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 50, 15) }).ok).toBe(false);
  });

  it('a spearhead crosses a strait and takes land on the far shore; without the tech it cannot launch', () => {
    const s = straitGame(4, 2);
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    const far = at(s, 31, 15);
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: far }).ok).toBe(false);
    give(s, 1, 'amphibiousTanks');
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: far }).ok).toBe(true);
    runUntil(s, () => d.state === 3, 300);
    expect(d.state).toBe(3);
    runUntil(s, () => d.state !== 3 || d.hp <= 0, 2000);
    let taken = 0;
    for (let x = 29; x < 70; x++) if (s.map.owner[at(s, x, 15)] === 1) taken++;
    expect(taken).toBeGreaterThan(3);
  });

  it('counter: enemy warships off the strait bleed a wading division', () => {
    const lostWith = (ship: boolean): number => {
      const s = straitGame(4, 1);
      give(s, 1, 'amphibiousTanks');
      s.players[2].techs.push('navigation');
      const d = spawnTankDivision(s, 1, at(s, 20, 15));
      if (ship) spawnWarshipAt(s, 2, at(s, 26, 2), at(s, 27, 8));
      expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 40, 15) }).ok).toBe(true);
      const before = troopSum(d.troops);
      runUntil(s, () => d.state === 0 && d.x > 30, 400);
      return before - troopSum(d.troops);
    };
    expect(lostWith(true)).toBeGreaterThan(lostWith(false) * 1.2);
  });
});

/** p1 west x 0..29, sea x 30..69, p2 east x 70..99; 100x60. */
function seaGame(seed = 6): GameState {
  const s = prep(makeFlatGame(100, 60, 2, { human: true, seed }));
  for (let y = 0; y < 60; y++) for (let x = 30; x < 70; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 29, 59);
  claimRect(s, 2, 70, 0, 99, 59);
  give(s, 1, 'navigation');
  give(s, 2, 'navigation');
  return s;
}

describe('Naval Mines', () => {
  it('mines the sea around own finished ports; hostile warships there are damaged and sink, own ones are safe', () => {
    const s = seaGame();
    const port = addBuilding(s, 'port', 1, at(s, 29, 30));
    const foe = spawnWarshipAt(s, 2, at(s, 70, 30), at(s, 34, 30));
    expect(minefields(s)).toEqual([]);
    run(s, 50);
    expect(foe.hp).toBeGreaterThan(2.99); // no mines yet (and no war: nobody shoots)
    give(s, 1, 'navalMines');
    expect(minefields(s).length).toBe(1);
    expect(isMinedFor(s, at(s, 34, 30), 2)).toBe(true);
    expect(isMinedFor(s, at(s, 34, 30), 1)).toBe(false);
    expect(isMinedFor(s, at(s, 50, 30), 2)).toBe(false);
    runUntil(s, () => foe.hp <= 0, 1500); // it wanders in and out of the field
    expect(foe.hp).toBeLessThanOrEqual(0);
    expect(s.units.includes(foe)).toBe(false);
    expect(s.events.some((e) => e.message.includes('hit a mine'))).toBe(true);
    const mine = spawnWarshipAt(s, 1, port.tile, at(s, 33, 33));
    run(s, 100);
    expect(mine.hp).toBe(3);
  });

  it('a destroyer is immune (sweeper); a destroyed port clears its field', () => {
    const s = seaGame();
    give(s, 1, 'navalMines');
    const port = addBuilding(s, 'port', 1, at(s, 29, 30));
    const d = spawnWarshipAt(s, 2, at(s, 70, 30), at(s, 34, 30));
    d.variant = 'destroyer';
    run(s, 100);
    expect(d.hp).toBe(3);
    s.buildings.delete(port.id);
    s.map.building[port.tile] = 0;
    markBuildingsChanged(s);
    expect(minefields(s)).toEqual([]);
  });

  it('invasions sailing through a minefield lose troops; an escort sweeps a lane', () => {
    const lossOf = (escort: boolean, mines: boolean): number => {
      const s = seaGame();
      if (mines) give(s, 1, 'navalMines');
      addBuilding(s, 'port', 1, at(s, 29, 30));
      const u: Unit = { id: newId(s), type: 'transport', owner: 2, x: 30, y: 30, target: at(s, 29, 30), home: at(s, 70, 30), path: [], pathPos: 0, troops: { infantry: 10000, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 1 };
      for (let x = 69; x >= 30; x--) u.path.push(at(s, x, 30));
      u.pathPos = u.path.length;
      if (escort) spawnWarshipAt(s, 2, at(s, 70, 30), at(s, 32, 31));
      return mineLandingLoss(s, u);
    };
    expect(lossOf(false, false)).toBe(0);
    const bare = lossOf(false, true);
    // 9 mined tiles at 3% each
    expect(bare).toBeGreaterThan(10000 * 0.2);
    expect(bare).toBeLessThanOrEqual(10000 * SPECIALS.mineTransportMaxLoss + 1e-6);
    expect(lossOf(true, true)).toBeCloseTo(bare * SPECIALS.mineEscortMul, 3);
  });
});

/** p2 west x 0..39 with an airfield, p1 east x 40..199; 200x110. */
function airGame(seed = 8): GameState {
  const s = prep(makeFlatGame(200, 110, 2, { human: true, seed }));
  claimRect(s, 2, 0, 0, 39, 109);
  claimRect(s, 1, 40, 0, 199, 109);
  give(s, 1, 'logistics', 'flight', 'radar');
  give(s, 2, 'logistics', 'flight');
  return s;
}
function flyBomber(s: GameState, from: Building, to: number): Unit {
  from.bombers++;
  expect(launchBomber(s, 2, from.tile, to).ok).toBe(true); // AIs are frozen: straight to the sim
  return s.units[s.units.length - 1];
}

describe('Early Warning', () => {
  it('SAMs engage farther out: a bomber passing outside the normal ring is shot down', () => {
    const outcome = (ew: boolean): number => {
      const s = airGame();
      if (ew) give(s, 1, 'earlyWarning');
      const af = addBuilding(s, 'airfield', 2, at(s, 10, 10));
      addBuilding(s, 'sam', 1, at(s, 100, 80)); // 70 tiles off the flight line (radius 60, x1.4 = 84)
      flyBomber(s, af, at(s, 190, 10));
      run(s, 150);
      return s.events.filter((e) => e.message.includes('shot down')).length;
    };
    expect(outcome(false)).toBe(0);
    expect(outcome(true)).toBe(1);
    const s = airGame();
    give(s, 1, 'earlyWarning');
    expect(earlyWarningMul(s, 1)).toBe(SPECIALS.ewRadiusMul);
    expect(earlyWarningMul(s, 2)).toBe(1);
  });

  it('sees enemy submarines farther from the coast', () => {
    const s = seaGame();
    const sub = spawnWarshipAt(s, 2, at(s, 70, 30), at(s, 50, 30)); // 20 tiles off p1's coast (x 29)
    sub.variant = 'submarine';
    expect(unitVisibleTo(s, 1, sub)).toBe(false);
    give(s, 1, 'earlyWarning');
    expect(unitVisibleTo(s, 1, sub)).toBe(true);
  });
});

describe('Drop Tanks', () => {
  it('longer air-wing, patrol and paradrop reach', () => {
    const s = airGame();
    const af = addBuilding(s, 'airfield', 2, at(s, 10, 50));
    const r0 = airWingRange(af, s);
    const p0 = airPatrolRadius(af, s);
    const d0 = paradropRange(af, s);
    const far = at(s, 10 + Math.round(d0 * 1.3), 50);
    s.players[2].troops = { infantry: 50000, armor: 0, artillery: 0 };
    expect(canParadrop(s, 2, af.tile, far, 1000).ok).toBe(false);
    give(s, 2, 'dropTanks');
    expect(airWingRange(af, s)).toBeCloseTo(r0 * SPECIALS.dropTanksRange);
    expect(airWingRange(af)).toBe(AIR.range); // without the state: the base reach
    expect(airPatrolRadius(af, s)).toBeCloseTo(p0 * SPECIALS.dropTanksPatrol);
    expect(paradropRange(af, s)).toBe(Math.round(d0 * SPECIALS.dropTanksParadrop));
    expect(canParadrop(s, 2, af.tile, far, 1000).ok).toBe(true);
  });
});

describe('Night Bombing', () => {
  it('night bombers dodge most SAM fire, much less against Early Warning', () => {
    const s = airGame();
    give(s, 2, 'nightBombing');
    const b: Unit = { id: 1, type: 'bomber', owner: 2, x: 0, y: 0, target: 0, home: 0, path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 1 };
    let dodged = 0;
    for (let k = 0; k < 2000; k++) if (nightDodges(s, b, 1)) dodged++;
    expect(dodged / 2000).toBeGreaterThan(SPECIALS.nightDodge - 0.05);
    expect(dodged / 2000).toBeLessThan(SPECIALS.nightDodge + 0.05);
    give(s, 1, 'earlyWarning');
    dodged = 0;
    for (let k = 0; k < 2000; k++) if (nightDodges(s, b, 1)) dodged++;
    expect(dodged / 2000).toBeLessThan(SPECIALS.nightDodgeVsRadar + 0.05);
    // ordinary bombers never dodge (and draw nothing from the rng)
    const plain = { ...b, owner: 1 };
    expect(nightDodges(s, plain, 2)).toBe(false);
  });

  it('flies through SAM cover more often, but the bombs scatter and do less', () => {
    const survivors = (night: boolean): number => {
      let n = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const s = airGame(seed);
        if (night) give(s, 2, 'nightBombing');
        const af = addBuilding(s, 'airfield', 2, at(s, 10, 50));
        addBuilding(s, 'sam', 1, at(s, 100, 60));
        flyBomber(s, af, at(s, 190, 50));
        run(s, 150);
        if (!s.events.some((e) => e.message.includes('shot down'))) n++;
      }
      return n;
    };
    expect(survivors(false)).toBe(0);
    expect(survivors(true)).toBeGreaterThan(5);
    const s = airGame();
    give(s, 2, 'nightBombing');
    const b: Unit = { id: 1, type: 'bomber', owner: 2, x: 0, y: 0, target: at(s, 100, 50), home: 0, path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 1 };
    let moved = 0;
    for (let k = 0; k < 50; k++) {
      b.target = at(s, 100, 50);
      nightScatter(s, b);
      const dx = Math.abs((b.target % 200) - 100);
      const dy = Math.abs(((b.target / 200) | 0) - 50);
      expect(Math.max(dx, dy)).toBeLessThanOrEqual(SPECIALS.nightScatter);
      if (dx || dy) moved++;
    }
    expect(moved).toBeGreaterThan(30);
  });
});

describe('AI fit and determinism', () => {
  it('suggests specials that fit the nation', () => {
    const s = seaGame();
    give(s, 1, 'mechanization');
    addBuilding(s, 'port', 1, at(s, 29, 20));
    addBuilding(s, 'port', 1, at(s, 29, 40));
    spawnWarshipAt(s, 2, at(s, 70, 30), at(s, 60, 30));
    spawnTankDivision(s, 1, at(s, 10, 30));
    const picks = aiSpecialTechs(s, 1);
    expect(picks).toContain('navalMines');
    expect(picks).toContain('amphibiousTanks');
    expect(picks).not.toContain('nightBombing');
  });

  it('same actions, same hashes (crossing, mines, night bombers)', () => {
    const play = (): number[] => {
      const s = straitGame(4, 2, 11);
      give(s, 1, 'amphibiousTanks', 'navalMines');
      addBuilding(s, 'port', 2, at(s, 29, 3));
      give(s, 2, 'navalMines', 'navigation');
      const d = spawnTankDivision(s, 1, at(s, 20, 15));
      spawnWarshipAt(s, 1, at(s, 24, 3), at(s, 27, 4));
      applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 31, 15) });
      const out: number[] = [];
      for (let k = 0; k < 400; k++) {
        tick(s);
        if (k % 40 === 0) out.push(hashState(s));
      }
      return out;
    };
    expect(play()).toEqual(play());
  });
});
