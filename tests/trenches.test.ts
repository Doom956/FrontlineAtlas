// Dug-in borders (trenches.ts) and Air cover (airwings.ts): digging, caps, reset, decay, flattening, combat, AI use.
import { describe, expect, it } from 'vitest';
import { aiAirWings, airCoverActive, airCoverSorties, airState, MISSION_COVER, updateAir, wingOf } from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { estimateAttack, launchAttack, updateAttacks } from '../src/sim/combat';
import { AIR_COVER, DEFENSE_BONUS_CAP, DOCTRINE_LEVERS, TRENCH } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { doctrineAdvice } from '../src/sim/doctrines';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { createGame, newId, setOwner } from '../src/sim/state';
import {
  drainTrenchChanges,
  flattenDisc,
  frontTrench,
  setTrenchesOff,
  trenchInfoAt,
  trenchLevel,
  trenchMaxLevel,
  updateTrenches,
} from '../src/sim/trenches';
import { buildAircraft, updateUnits } from '../src/sim/units';
import { applyAction } from '../src/sim/actions';
import { updateBarrages } from '../src/sim/barrage';
import { Terrain } from '../src/sim/types';
import type { Building, DoctrineId, GameState, Troops } from '../src/sim/types';
import { claimRect, makeFlatGame, testSettings } from './helpers';

const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
const lvlAt = (s: GameState, x: number, y: number): number => trenchLevel(s, at(s, x, y));

/** 1 owns x 0..29, 2 owns x 30..59 of a 60 x 20 plain. */
function front(opts: { water?: boolean } = {}): GameState {
  const s = makeFlatGame(60, 20, 2, { seed: 3 });
  if (opts.water) {
    for (let x = 0; x < 60; x++) s.map.terrain[at(s, x, 0)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
  }
  claimRect(s, 1, 0, opts.water ? 1 : 0, 29, 19);
  claimRect(s, 2, 30, opts.water ? 1 : 0, 59, 19);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 100000;
    p.iron = 10000;
    p.oil = 10000;
    p.troops = inf(100000);
  }
  return s;
}
/** Runs only the trench passes for `seconds` of game time. */
function dig(s: GameState, seconds: number): void {
  for (let k = 0; k < seconds * 10; k++) {
    s.tick++;
    updateTrenches(s);
  }
}
function setDoctrine(s: GameState, pid: number, id: DoctrineId, level: 1 | 2 | 3 = 2): void {
  s.players[pid].doctrine = { id, level, chosenTick: 0, adaptUntilTick: 0, lastSwitchTick: 0 };
}
function addAirfield(s: GameState, owner: number, tile: number, bombers: number): Building {
  const id = newId(s);
  const b: Building = { id, type: 'airfield', owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  for (let k = 0; k < bombers; k++) expect(buildAircraft(s, owner, tile, 'bomber').ok).toBe(true);
  return b;
}

describe('digging', () => {
  it('borders between nations dig in band tiles deep, level 1 in ~45 s and level 2 (the cap) in ~90 s', () => {
    const s = front();
    dig(s, 50);
    expect(lvlAt(s, 29, 10)).toBe(1);
    expect(lvlAt(s, 30, 10)).toBe(1);
    expect(lvlAt(s, 30 - TRENCH.band, 10)).toBe(1); // the band's last ring
    expect(lvlAt(s, 29 - TRENCH.band, 10)).toBe(0);
    dig(s, 50);
    expect(lvlAt(s, 29, 10)).toBe(2);
    dig(s, 200);
    expect(lvlAt(s, 29, 10)).toBe(TRENCH.baseMaxLevel);
    expect(s.trench!.dig[at(s, 29, 10)]).toBe(TRENCH.baseMaxLevel * TRENCH.pointsPerLevel);
    expect(trenchInfoAt(s, at(s, 29, 10))).toMatchObject({ owner: 1, level: 2, max: 2 });
    expect(trenchInfoAt(s, at(s, 10, 10))).toBeNull();
    expect(frontTrench(s, 1, 2)).toBe(2);
    expect(frontTrench(s, 2, 1)).toBe(2);
  });

  it('coasts, tribes, allies and the wilderness never dig', () => {
    const s = front({ water: true });
    dig(s, 100);
    expect(lvlAt(s, 29, 1)).toBe(0); // coastal
    expect(lvlAt(s, 29, 5)).toBe(2);

    const t = front();
    t.players[2].personality = 'tribe';
    dig(t, 100);
    expect(lvlAt(t, 29, 10)).toBe(0);
    expect(lvlAt(t, 30, 10)).toBe(0);

    const a = front();
    formAlliance(a, 1, 2);
    dig(a, 100);
    expect(lvlAt(a, 29, 10)).toBe(0);

    const w = makeFlatGame(40, 10, 1, { seed: 2 });
    claimRect(w, 1, 0, 0, 19, 9); // neighbour: wilderness
    dig(w, 100);
    expect(lvlAt(w, 19, 5)).toBe(0);
  });

  it('a captured tile starts undug and the change feed lists level changes only', () => {
    const s = front();
    drainTrenchChanges(s);
    dig(s, 50);
    const first = drainTrenchChanges(s);
    expect(first.count).toBeGreaterThan(0);
    expect(drainTrenchChanges(s).count).toBe(0);
    dig(s, 4); // < one pass of points: no level changes
    expect(drainTrenchChanges(s).count).toBe(0);
    setOwner(s, at(s, 29, 10), 2);
    expect(lvlAt(s, 29, 10)).toBe(0);
    const ch = drainTrenchChanges(s);
    expect(Array.from(ch.tiles.subarray(0, ch.count))).toContain(at(s, 29, 10));
  });

  it('old lines decay once the border is gone (an alliance)', () => {
    const s = front();
    dig(s, 100);
    expect(lvlAt(s, 29, 10)).toBe(2);
    formAlliance(s, 1, 2);
    dig(s, 50); // 10 passes x 6 = 60 points
    expect(s.trench!.dig[at(s, 29, 10)]).toBe(100 - 10 * TRENCH.decayPoints);
    dig(s, 100);
    expect(s.trench!.dig[at(s, 29, 10)]).toBe(0);
  });

  it('Fortress digs faster, deeper and in a wider band; Trench Warfare adds a level; the runaway leader digs slower', () => {
    const s = front();
    setDoctrine(s, 1, 'fortress');
    expect(trenchMaxLevel(s, 1)).toBe(3);
    dig(s, 30); // 6 passes x 12 = 72 points (x2 at level 2)
    expect(lvlAt(s, 29, 10)).toBe(1);
    expect(lvlAt(s, 30, 10)).toBe(0); // 36 points
    expect(lvlAt(s, 30 - TRENCH.fortressBand, 10)).toBe(1);
    dig(s, 100);
    expect(lvlAt(s, 29, 10)).toBe(3);
    s.players[1].techs.push('trenchWarfare');
    expect(trenchMaxLevel(s, 1)).toBe(4);
    dig(s, 100);
    expect(lvlAt(s, 29, 10)).toBe(4);

    // Leader: 1 owns 2/3 of the land.
    const l = makeFlatGame(60, 20, 2, { seed: 3 });
    claimRect(l, 1, 0, 0, 39, 19);
    claimRect(l, 2, 40, 0, 59, 19);
    dig(l, 50);
    expect(l.trench!.dig[at(l, 39, 10)]).toBe(10 * Math.max(1, Math.floor(TRENCH.digPoints * TRENCH.leaderDigMul)));
    expect(l.trench!.dig[at(l, 40, 10)]).toBe(10 * TRENCH.digPoints);
  });

  it('the off switch stops digging and reads 0 everywhere', () => {
    const s = front();
    dig(s, 100);
    setTrenchesOff(s, true);
    expect(lvlAt(s, 29, 10)).toBe(0);
    expect(frontTrench(s, 2, 1)).toBe(0);
    setTrenchesOff(s, false);
    expect(lvlAt(s, 29, 10)).toBe(2);
  });
});

describe('flattening', () => {
  it('barrages take 2 levels off hostile tiles only; atom bombs fill everything', () => {
    const s = front();
    dig(s, 100);
    flattenDisc(s, at(s, 30, 10), 3, TRENCH.barrageFlatten, 1);
    expect(lvlAt(s, 30, 10)).toBe(0);
    expect(lvlAt(s, 29, 10)).toBe(2); // the shooter's own trench
    expect(lvlAt(s, 30, 2)).toBe(2); // outside the disc
    flattenDisc(s, at(s, 29, 10), 3, 255, 0);
    expect(lvlAt(s, 29, 10)).toBe(0);
  });

  it('a real barrage flattens the trench it lands on', () => {
    const s = front();
    dig(s, 100);
    s.players[1].troops = { infantry: 50000, armor: 0, artillery: 20000 };
    const t0 = s.tick;
    const r = launchAttack(s, 1, at(s, 30, 10), inf(1000)); // at war, so the barrage is allowed in any rule set
    expect(r.ok).toBe(true);
    const tile = at(s, 31, 10);
    expect(lvlAt(s, 31, 10)).toBe(2);
    expect(applyAction(s, 1, { type: 'barrage', tile }).ok).toBe(true);
    for (let k = 0; k < 40; k++) {
      s.tick++;
      updateBarrages(s);
    }
    expect(s.tick - t0).toBe(40);
    expect(lvlAt(s, 31, 10)).toBe(0);
  });

  it('a live air-support zone of a nation at war flattens TRENCH.zoneFlattenPerPass per pass (Air doctrine faster)', () => {
    const run = (air: boolean): number => {
      const s = front();
      dig(s, 100);
      if (air) setDoctrine(s, 2, 'air');
      expect(launchAttack(s, 2, at(s, 29, 10), inf(1000)).ok).toBe(true);
      airState(s).zones.push({ wing: -1, owner: 2, tile: at(s, 27, 10), radius: 4, strength: 1, untilTick: s.tick + 10000, victim: 1, tiles: 20 });
      const before = s.trench!.dig[at(s, 27, 10)];
      dig(s, 10); // two passes of player 1
      expect(lvlAt(s, 27, 2)).toBe(2); // outside the zone
      return before - s.trench!.dig[at(s, 27, 10)];
    };
    // Each pass digs first (capped), then the zone flattens: the second pass's digging is the only one that counts
    // (a tile can't lose more than the 100 points it held).
    expect(run(false)).toBe(Math.min(100, 2 * TRENCH.zoneFlattenPerPass - TRENCH.digPoints));
    expect(run(true)).toBe(Math.min(100, 2 * Math.round(TRENCH.zoneFlattenPerPass * (1 + DOCTRINE_LEVERS.air.airFlatten!)) - TRENCH.digPoints));
    expect(run(true)).toBeGreaterThan(run(false));
  });
});

describe('combat', () => {
  const est = (s: GameState, x: number, troops: Troops) => estimateAttack(s, 1, at(s, x, 10), troops, 20)!;

  it('a dug tile costs x(1 + step x level) in losses and budget; artillery breaches part of it', () => {
    const s = front();
    const base = est(s, 30, inf(50000));
    dig(s, 100);
    const dug = est(s, 30, inf(50000));
    expect(dug.trench).toBe(2);
    expect(dug.trenchPct).toBeCloseTo(2 * TRENCH.step, 6);
    expect(dug.lossPerTile / base.lossPerTile).toBeCloseTo(1 + 2 * TRENCH.step, 6);
    expect(base.tilesPerSecond / dug.tilesPerSecond).toBeCloseTo(1 + 2 * TRENCH.slow, 6);
    const guns = { infantry: 30000, armor: 0, artillery: 20000 };
    const g = est(s, 30, guns);
    expect(g.trench).toBeLessThan(2);
    expect(g.trench).toBeGreaterThan(0);
    // inside the cap: never more than DEFENSE_BONUS_CAP x the undug defence
    expect(dug.defensePerTile / base.defensePerTile).toBeLessThanOrEqual(DEFENSE_BONUS_CAP);
  });

  it('Siege artillery attack applies only against dug or fortified tiles; Blitz speed only on undug open ground', () => {
    const s = front();
    dig(s, 100);
    const guns = { infantry: 0, armor: 0, artillery: 20000 };
    const deep = 29 - TRENCH.band - 2; // undug enemy tile, attacked by player 2
    const est2 = (x: number) => estimateAttack(s, 2, at(s, x, 10), guns, 20)!;
    const undug0 = est2(deep);
    const dug0 = est2(29);
    setDoctrine(s, 2, 'siege');
    expect(est2(deep).lossPerTile).toBeCloseTo(undug0.lossPerTile, 9);
    expect(dug0.lossPerTile / est2(29).lossPerTile).toBeCloseTo(1 + DOCTRINE_LEVERS.siege.artilleryAttack!, 6);

    const b = front();
    dig(b, 100);
    const e1 = (x: number) => estimateAttack(b, 2, at(b, x, 10), inf(50000), 20)!;
    const undug = e1(deep).tilesPerSecond;
    const dug = e1(29).tilesPerSecond;
    setDoctrine(b, 2, 'blitz');
    expect(e1(deep).tilesPerSecond / undug).toBeCloseTo(1 + DOCTRINE_LEVERS.blitz.openGroundSpeed!, 6);
    expect(e1(29).tilesPerSecond / dug).toBeCloseTo(1, 9);
  });

  it('attacks take thin (undug) stretches first', () => {
    const s = front();
    dig(s, 100);
    // Flatten the north half of 2's line.
    for (let y = 0; y < 10; y++) for (let x = 30; x < 34; x++) s.trench!.dig[at(s, x, y)] = 0;
    s.players[1].troops = inf(400000);
    expect(launchAttack(s, 1, at(s, 30, 10), inf(300000)).ok).toBe(true);
    for (let k = 0; k < 30; k++) {
      updateAttacks(s);
      s.tick++;
    }
    let north = 0;
    let south = 0;
    for (let y = 0; y < 20; y++) for (let x = 30; x < 34; x++) if (s.map.owner[at(s, x, y)] === 1) (y < 10 ? north++ : south++);
    expect(north).toBeGreaterThan(south);
  });
});

describe('Air cover', () => {
  /** 1 (Air doctrine, Flight) attacks 2's dug line; its idle airfield holds bombers. */
  function coverGame(opts: { air?: boolean; dug?: boolean; airfields?: number } = {}): { s: GameState; afs: Building[] } {
    const s = front();
    s.players[1].techs.push('flight');
    if (opts.dug !== false) dig(s, 100);
    if (opts.air !== false) setDoctrine(s, 1, 'air');
    const afs: Building[] = [];
    for (let k = 0; k < (opts.airfields ?? 1); k++) afs.push(addAirfield(s, 1, at(s, 10 + 4 * Math.floor(k / 5), 2 + 4 * (k % 5)), 3));
    expect(launchAttack(s, 1, at(s, 30, 10), inf(5000)).ok).toBe(true);
    return { s, afs };
  }
  /** Runs Air updates for `seconds` (no combat, so the front stays put). */
  function fly(s: GameState, seconds: number): void {
    for (let k = 0; k < seconds * 10; k++) {
      s.tick++;
      updateAir(s);
    }
  }
  const coverBombers = (s: GameState): number => s.units.filter((u) => u.type === 'bomber' && u.mission === MISSION_COVER).length;

  it('an idle airfield of an Air holder bombs the dug front by itself, aimed at the deepest tile, once per cooldown', () => {
    const { s, afs } = coverGame();
    expect(airCoverActive(s, afs[0].tile)).toBe(true);
    fly(s, 1);
    expect(coverBombers(s)).toBeGreaterThan(0);
    expect(airCoverSorties(s, 1)).toBe(1);
    const aim = s.units.find((u) => u.mission === MISSION_COVER)!.target;
    expect(s.map.owner[aim]).toBe(2);
    expect(trenchLevel(s, aim)).toBe(2);
    expect(wingOf(s, afs[0])).toBeUndefined(); // still idle: no mission was set
    fly(s, 5);
    expect(airCoverSorties(s, 1)).toBe(1); // cooling down
  });

  it('needs the Air doctrine and a dug or stalled front; at most AIR_COVER.maxAirfields airfields at once', () => {
    expect(airCoverSorties((() => { const g = coverGame({ air: false }); fly(g.s, 2); return g.s; })(), 1)).toBe(0);
    const undug = coverGame({ dug: false });
    fly(undug.s, 2);
    expect(airCoverSorties(undug.s, 1)).toBe(0); // moving, undug front (the stall window has not run yet)
    fly(undug.s, AIR_COVER.stallSeconds + 2); // no combat ran: the attack took nothing, so it stalled
    expect(airCoverSorties(undug.s, 1)).toBeGreaterThan(0);
    const many = coverGame({ airfields: AIR_COVER.maxAirfields + 1 });
    fly(many.s, 3);
    expect(airCoverSorties(many.s, 1)).toBe(AIR_COVER.maxAirfields);
  });

  it('auto-cover zones last AIR_COVER.zoneMul longer', () => {
    const { s } = coverGame();
    fly(s, 1);
    for (let k = 0; k < 600 && !airState(s).zones.length; k++) {
      updateUnits(s);
      updateAir(s);
      s.tick++;
    }
    const z = airState(s).zones[0];
    expect(z).toBeDefined();
    expect(z.untilTick - s.tick).toBeGreaterThan(24 * 10);
  });

  it('the AI Air holder leaves the airfield nearest a dug main front idle (Air cover flies it) and others support', () => {
    const { s, afs } = coverGame({ airfields: 2 });
    s.players[1].isHuman = false;
    aiAirWings(s, 1, [2], false);
    const missions = afs.map((b) => wingOf(s, b)?.mission ?? 'idle');
    expect(missions.filter((m) => m === 'idle').length).toBe(1);
    expect(missions.filter((m) => m === 'support').length).toBe(1);
  });
});

describe('AI doctrine advice', () => {
  it('a dug-in enemy line raises Siege and Air (Air harder); own dug borders leave Fortress as it was', () => {
    const s = front();
    const score = (pid: number, id: DoctrineId): number => doctrineAdvice(s, pid).find((a) => a.id === id)!.score;
    const siege0 = score(1, 'siege');
    const air0 = score(1, 'air');
    const fort0 = score(1, 'fortress');
    dig(s, 100);
    expect(score(1, 'siege')).toBeCloseTo(siege0 + Math.min(0.4, 0.15 * 2), 6);
    expect(score(1, 'air')).toBeCloseTo(air0 + Math.min(0.5, 0.3 * 2), 6);
    // Fortress: no trench term (it steered losing nations into Fortress).
    expect(score(1, 'fortress')).toBeCloseTo(fort0, 6);
  });
});

describe('determinism', () => {
  it('two games with the same settings dig the same trenches (same hash); the hash covers the dig points', async () => {
    const settings = testSettings({ humanPlayer: false, aiCount: 5, seed: 4242 });
    const a = createGame(settings);
    const b = createGame(settings);
    for (let k = 0; k < 4000; k++) {
      // Lets the test runner's worker talk to its main process during the long synchronous run.
      if (k % 200 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      tick(a);
      tick(b);
    }
    expect(hashState(a)).toBe(hashState(b));
    let dugTiles = 0;
    for (const d of a.trench!.dig) if (d >= TRENCH.pointsPerLevel) dugTiles++;
    expect(dugTiles).toBeGreaterThan(0);
    const i = a.trench!.dig.findIndex((d) => d > 0);
    a.trench!.dig[i]--;
    expect(hashState(a)).not.toBe(hashState(b));
  });
});
