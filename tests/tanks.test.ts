// Tank divisions (tanks.ts): building at a Factory, driving over own land, spearheads, previews, defence, bombers.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { TANK_BUILD_SECONDS, TANK_DEFENSE_BONUS, TANK_DIVISION_TROOPS, TICKS_PER_SECOND, UNITS } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { aiTankDivisions, bombDivisions, ownLandPath, spawnTankDivision, spearheadPreview, tankDefenseAt, tankDivisionCost, tankDivisionLimit } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 60x30 plains: player 1 (human) owns x 0..29, player 2 (AI) x 30..59. AIs frozen so only our orders act. */
function landGame(seed = 3): GameState {
  const s = makeFlatGame(60, 30, 2, { human: true, seed });
  claimRect(s, 1, 0, 0, 29, 29);
  claimRect(s, 2, 30, 0, 59, 29);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99; // half the map each: no early win
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
  s.players[1].techs.push('mechanization');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 0 };
  s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
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
const divisions = (s: GameState, owner = 1): Unit[] => s.units.filter((u) => u.type === 'tankDivision' && u.owner === owner && u.hp > 0);
function run(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) tick(s);
}
function runUntil(s: GameState, pred: () => boolean, max = 3000): void {
  for (let k = 0; k < max && !pred(); k++) tick(s);
}
const sum = (t: { infantry: number; armor: number; artillery: number }): number => t.infantry + t.armor + t.artillery;

describe('building tank divisions', () => {
  it('needs Mechanization, an own finished Factory and armor; costs gold, iron, oil and troops; limited per level', () => {
    const s = landGame();
    const build = (tile: number, pid = 1) => applyAction(s, pid, { type: 'buildTankDivision', tile });
    const f = addBuilding(s, 'factory', 1, at(s, 10, 15));
    s.players[1].techs = [];
    expect(build(f.tile).reason).toMatch(/Mechanization/);
    s.players[1].techs.push('mechanization');
    expect(build(at(s, 11, 15)).reason).toMatch(/Factory of yours/);
    f.buildLeft = 5;
    expect(build(f.tile).reason).toMatch(/construction/);
    f.buildLeft = 0;
    markBuildingsChanged(s);
    s.players[1].troops.armor = 100;
    expect(build(f.tile).reason).toMatch(/armor/);
    s.players[1].troops.armor = 20000;
    const before = { ...s.players[1] };
    const pool = { ...s.players[1].troops };
    expect(build(f.tile).ok).toBe(true);
    const p = s.players[1];
    expect(p.gold).toBe(before.gold - UNITS.tankDivision.gold);
    expect(p.iron).toBe(before.iron - UNITS.tankDivision.iron);
    expect(p.oil).toBe(before.oil - UNITS.tankDivision.oil);
    expect(p.troops.armor).toBe(pool.armor - TANK_DIVISION_TROOPS.armor);
    expect(p.troops.infantry).toBe(pool.infantry - TANK_DIVISION_TROOPS.infantry);
    expect(tankDivisionLimit(s, 1)).toBe(1);
    expect(build(f.tile).reason).toMatch(/At most 1/);
    run(s, Math.round(TANK_BUILD_SECONDS * TICKS_PER_SECOND) + 1);
    const d = divisions(s);
    expect(d.length).toBe(1);
    expect(sum(d[0].troops)).toBe(TANK_DIVISION_TROOPS.armor + TANK_DIVISION_TROOPS.infantry);
    expect(s.events.some((e) => e.kind === 'tankDivisionReady' && e.players.includes(1))).toBe(true);
    expect(tankDivisionCost(s, 1).gold).toBe(UNITS.tankDivision.gold);
  });
});

describe('moving tank divisions', () => {
  it('drives over own land only; refuses water, foreign units and bad lists', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 5, 5));
    expect(ownLandPath(s, 1, at(s, 5, 5), at(s, 20, 25))!.length).toBeGreaterThan(10);
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 20, 25) }).ok).toBe(true);
    expect(d.state).toBe(1);
    runUntil(s, () => d.state === 0, 400);
    expect(Math.round(d.x)).toBe(20);
    expect(Math.round(d.y)).toBe(25);
    const e = spawnTankDivision(s, 2, at(s, 40, 5));
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [e.id], tile: at(s, 45, 5) }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id, d.id], tile: at(s, 10, 5) }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 50, 5) }).reason).toMatch(/border/);
    s.map.terrain[at(s, 12, 12)] = Terrain.DeepWater;
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 12, 12) }).reason).toMatch(/land/);
  });

  it('a spearhead breaks through on plains, ends spent or at depth, and reports', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    const enemyTiles = s.players[2].tiles;
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 30, 15) }).ok).toBe(true);
    expect(d.state).toBe(2);
    let started = false;
    runUntil(s, () => {
      if (d.state === 3) started = true;
      return started && (d.state !== 3 || d.hp <= 0);
    }, 3000);
    expect(started).toBe(true);
    const taken = enemyTiles - s.players[2].tiles;
    expect(taken).toBeGreaterThanOrEqual(8);
    // The line went east from the launch tile.
    expect(s.map.owner[at(s, 33, 15)]).toBe(1);
    expect(s.events.some((e) => e.kind === 'spearheadStarted')).toBe(true);
    const end = s.events.find((e) => e.kind === 'spearheadEnded');
    expect(end?.message).toMatch(/tiles taken/);
    expect(end?.players).toContain(2);
  });

  it('mountains and forts stop a division without artillery; artillery pushes through', () => {
    const mk = (arty: number): GameState => {
      const s = landGame();
      for (let y = 0; y < 30; y++) s.map.terrain[at(s, 34, y)] = Terrain.Mountains;
      const d = spawnTankDivision(s, 1, at(s, 25, 15));
      d.troops.artillery = arty;
      applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 30, 15) });
      let started = false;
      runUntil(s, () => {
        if (d.state === 3) started = true;
        return started && d.state !== 3;
      }, 3000);
      return s;
    };
    const blocked = mk(0);
    expect(blocked.map.owner[at(blocked, 33, 15)]).toBe(1);
    expect(blocked.map.owner[at(blocked, 34, 15)]).toBe(2);
    expect(blocked.events.find((e) => e.kind === 'spearheadEnded')?.message).toMatch(/mountains/);
    const supported = mk(2000);
    expect(supported.map.owner[at(supported, 34, 15)]).toBe(1);

    const f = landGame();
    addBuilding(f, 'fort', 2, at(f, 33, 15), 3);
    const d = spawnTankDivision(f, 1, at(f, 25, 15));
    d.troops.artillery = 0;
    applyAction(f, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(f, 30, 15) });
    let started = false;
    runUntil(f, () => {
      if (d.state === 3) started = true;
      return started && d.state !== 3;
    }, 3000);
    expect(f.events.find((e) => e.kind === 'spearheadEnded')?.message).toMatch(/fort/);
  });

  it('refuses allies and peace time', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 25, 15));
    formAlliance(s, 1, 2);
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 30, 15) }).reason).toMatch(/ally/);
    const p = landGame();
    p.settings.modifiers.peaceMinutes = 10;
    const e = spawnTankDivision(p, 1, at(p, 25, 15));
    expect(applyAction(p, 1, { type: 'moveTankDivision', unitIds: [e.id], tile: at(p, 30, 15) }).reason).toMatch(/Peace/);
  });

  it('spearheadPreview shows the line, the expected depth and warnings, without changing anything', () => {
    const s = landGame();
    for (let y = 0; y < 30; y++) s.map.terrain[at(s, 40, y)] = Terrain.Mountains;
    const d = spawnTankDivision(s, 1, at(s, 25, 15));
    d.troops.artillery = 0; // no artillery support: mountains stop it
    const h = hashState(s);
    const pv = spearheadPreview(s, 1, d.id, at(s, 30, 15));
    expect(hashState(s)).toBe(h);
    expect(pv.reason).toBe('');
    expect(pv.launch).toBe(at(s, 29, 15));
    expect(pv.path.length).toBeGreaterThan(10);
    expect(pv.expectedDepth).toBeGreaterThanOrEqual(5);
    expect(pv.expectedDepth).toBeLessThanOrEqual(11);
    expect(pv.warnings.join(' ')).toMatch(/Mountains ahead: spearhead will stall/);
    expect(spearheadPreview(s, 1, d.id, at(s, 55, 15)).reason).toMatch(/border/);
  });

  it('holding divisions stiffen the defence; bombers hurt divisions on the move', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 25, 15));
    expect(tankDefenseAt(s, 1, at(s, 27, 15))).toBeCloseTo(1 + TANK_DEFENSE_BONUS);
    expect(tankDefenseAt(s, 1, at(s, 5, 5))).toBe(1);
    expect(tankDefenseAt(s, 2, at(s, 27, 15))).toBe(1);
    const t0 = sum(d.troops);
    bombDivisions(s, 2, at(s, 25, 15));
    expect(sum(d.troops)).toBe(t0); // holding: not on the move
    d.state = 1;
    bombDivisions(s, 2, at(s, 25, 15));
    expect(sum(d.troops)).toBeLessThan(t0);
  });

  it('a division whose ground is taken falls back home', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 25, 15));
    const pool = sum(s.players[1].troops);
    s.map.owner[at(s, 25, 15)] = 2;
    run(s, 1);
    expect(divisions(s).length).toBe(0);
    expect(sum(s.players[1].troops)).toBeGreaterThan(pool);
    expect(d.hp).toBe(0);
  });

  it('is deterministic', () => {
    const go = (): number => {
      const s = landGame(9);
      const f = addBuilding(s, 'factory', 1, at(s, 10, 15), 2);
      applyAction(s, 1, { type: 'buildTankDivision', tile: f.tile });
      const a = spawnTankDivision(s, 1, at(s, 20, 10));
      const b = spawnTankDivision(s, 1, at(s, 20, 20));
      run(s, 5);
      applyAction(s, 1, { type: 'moveTankDivision', unitIds: [a.id, b.id], tile: at(s, 31, 15) });
      run(s, 400);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});

describe('AI tank divisions', () => {
  it('a rich warlord AI builds a division from its armor', () => {
    const s = makeFlatGame(60, 30, 2, { seed: 5 });
    claimRect(s, 1, 0, 0, 29, 29);
    claimRect(s, 2, 30, 0, 59, 29);
    s.settings.victoryLandShare = 0.99;
    const ai = s.players[1];
    ai.personality = 'warlord';
    ai.techs.push('mechanization');
    ai.gold = 1e6;
    ai.iron = 1e5;
    ai.oil = 1e5;
    ai.troops = { infantry: 80000, armor: 30000, artillery: 5000 };
    addBuilding(s, 'factory', 1, at(s, 10, 15), 2);
    run(s, Math.round((TANK_BUILD_SECONDS + 60) * TICKS_PER_SECOND));
    const built = s.events.some((e) => e.kind === 'tankDivisionReady' && e.players.includes(1));
    expect(built).toBe(true);
  });

  it('an idle AI division strikes back at the nation attacking it', () => {
    const s = landGame();
    const ai = s.players[1];
    ai.isHuman = false;
    ai.personality = 'balanced';
    s.admin!.aiFrozen = false; // no ticks here: only the calls below act
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    const act = (a: Parameters<typeof applyAction>[2]) => applyAction(s, 1, a);
    // At peace: it holds.
    aiTankDivisions(s, 1, act);
    expect(d.state).toBe(0);
    // Player 2 attacks us: the division heads for a spearhead into player 2.
    expect(applyAction(s, 2, { type: 'attack', tile: at(s, 29, 15), troops: { infantry: 5000, armor: 0, artillery: 0 } }).ok).toBe(true);
    aiTankDivisions(s, 1, act);
    expect(d.state).toBe(2);
    expect(d.targetOwner).toBe(2);
  });
});
