// Tank divisions, part two (armor2.ts): reusable divisions, refit, veterancy, encirclement, support mode, AI.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiDivisionModes, collapsePockets, divisionLimitFor, divisionStrength, onSpearheadEnded, vetLossMul, vetSpeedMul } from '../src/sim/armor2';
import { markBuildingsChanged } from '../src/sim/buildings';
import { ARMOR_REFIT_FACTORY, ARMOR_REFIT_FIELD, ARMOR_VET_XP, TANK_BUILD_SECONDS, TANK_DIVISION_TROOPS, UNITS } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId, setOwner } from '../src/sim/state';
import { spawnTankDivision, tankDivisionLimit } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import type { Action, Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
const FULL = TANK_DIVISION_TROOPS.armor + TANK_DIVISION_TROOPS.infantry + TANK_DIVISION_TROOPS.artillery;

/** 60x30 plains: player 1 (human) owns x 0..29, player 2 (AI) x 30..59. AIs frozen so only our orders act. */
function landGame(seed = 3): GameState {
  const s = makeFlatGame(60, 30, 2, { human: true, seed });
  claimRect(s, 1, 0, 0, 29, 29);
  claimRect(s, 2, 30, 0, 59, 29);
  s.players[2].capital = at(s, 55, 15);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
  s.players[1].techs.push('mechanization');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
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
function run(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) tick(s);
}
function runUntil(s: GameState, pred: () => boolean, max = 3000): void {
  for (let k = 0; k < max && !pred(); k++) tick(s);
}
const sum = troopSum;

describe('reusable divisions', () => {
  it('cheaper and quicker than before; a spearhead leaves a division that holds and refits', () => {
    expect(UNITS.tankDivision.gold).toBeLessThan(1800);
    expect(TANK_BUILD_SECONDS).toBeLessThan(20);
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 30, 15) }).ok).toBe(true);
    let started = false;
    runUntil(s, () => {
      if (d.state === 3) started = true;
      return started && d.state !== 3;
    }, 3000);
    expect(started).toBe(true);
    expect(d.hp).toBe(1);
    expect(d.state).toBe(0);
    const left = sum(d.troops);
    expect(left).toBeLessThan(FULL);
    // Refits in the field (slowly) from the pool.
    run(s, 100);
    expect(sum(d.troops)).toBeGreaterThan(left);
  });

  it('refits fast near a Factory, slowly elsewhere, from the home pool', () => {
    const s = landGame();
    addBuilding(s, 'factory', 1, at(s, 5, 5));
    const a = spawnTankDivision(s, 1, at(s, 6, 6));
    const b = spawnTankDivision(s, 1, at(s, 20, 25));
    for (const u of [a, b]) for (const k of ['armor', 'infantry', 'artillery'] as const) u.troops[k] *= 0.4;
    const pool0 = sum(s.players[1].troops);
    const a0 = sum(a.troops);
    const b0 = sum(b.troops);
    run(s, 100); // 10 s
    const ga = sum(a.troops) - a0;
    const gb = sum(b.troops) - b0;
    expect(ga).toBeGreaterThan(gb * 3);
    expect(ga).toBeCloseTo(ARMOR_REFIT_FACTORY * FULL * 10, -3);
    expect(gb).toBeCloseTo(ARMOR_REFIT_FIELD * FULL * 10, -3);
    expect(sum(s.players[1].troops)).toBeLessThan(pool0 + 1e6); // the pool paid for it (growth aside)
    expect(divisionStrength(a)).toBeLessThanOrEqual(1);
  });

  it('veterancy after successful spearheads: faster, deeper, fewer losses', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    expect(vetSpeedMul(d)).toBe(1);
    onSpearheadEnded(s, d, 3); // too small to count
    expect(d.xp ?? 0).toBe(0);
    onSpearheadEnded(s, d, ARMOR_VET_XP[0]);
    expect(d.vet).toBe(1);
    expect(vetSpeedMul(d)).toBeGreaterThan(1);
    expect(vetLossMul(d)).toBeLessThan(1);
  });

  it('Railways raise the division cap', () => {
    const s = landGame();
    addBuilding(s, 'factory', 1, at(s, 5, 5), 2);
    expect(tankDivisionLimit(s, 1)).toBe(2);
    s.players[1].techs.push('railways');
    expect(tankDivisionLimit(s, 1)).toBe(3);
    expect(divisionLimitFor(s, 1, 0)).toBe(0);
  });
});

describe('encirclement', () => {
  /** Player 1 also owns column x = 42 except rows 14..16: player 2's land west of it is nearly cut off. */
  function pocketGame(): GameState {
    const s = landGame();
    for (let y = 0; y < 30; y++) if (y < 14 || y > 16) s.map.owner[at(s, 42, y)] = 0;
    claimRect(s, 1, 42, 0, 42, 13);
    claimRect(s, 1, 42, 17, 42, 29);
    return s;
  }

  it('pockets closed by the attacker collapse; open ones (neutral land next to them) do not', () => {
    const s = pocketGame();
    // Close the gap by hand (as if the head took it) and check the pockets from a line along row 15.
    claimRect(s, 1, 30, 14, 42, 16);
    const u: Unit = spawnTankDivision(s, 1, at(s, 29, 15));
    u.targetOwner = 2;
    const tiles0 = s.players[2].tiles;
    const troops0 = sum(s.players[2].troops);
    const taken = collapsePockets(s, u, at(s, 29, 15), 42, 15);
    expect(taken).toBe(12 * 14 + 12 * 13); // rows 0..13 and 17..29 of x 30..41
    expect(s.map.owner[at(s, 35, 5)]).toBe(1);
    expect(s.map.owner[at(s, 35, 25)]).toBe(1);
    expect(s.map.owner[at(s, 50, 5)]).toBe(2); // the main body (capital) stays
    expect(s.players[2].tiles).toBe(tiles0 - taken);
    expect(sum(s.players[2].troops)).toBeLessThan(troops0);
    expect(s.events.some((e) => /encircled/.test(e.message))).toBe(true);

    const o = pocketGame();
    claimRect(o, 1, 30, 14, 42, 16);
    o.map.owner[at(o, 35, 0)] = 0; // a neutral hole: the north piece is open
    o.players[2].tiles--;
    const v = spawnTankDivision(o, 1, at(o, 29, 15));
    v.targetOwner = 2;
    expect(collapsePockets(o, v, at(o, 29, 15), 42, 15)).toBe(12 * 13); // only the south piece
    expect(o.map.owner[at(o, 35, 5)]).toBe(2);
    expect(o.map.owner[at(o, 35, 25)]).toBe(1);
  });

  it('land still joined to the capital around the head does not collapse (open searches are not walls)', () => {
    // 100x40: water east of x 29; player 2 holds a strip x 20..29, y 0..29 (capital north), player 1 the rest.
    const s = makeFlatGame(100, 40, 2, { human: true, seed: 5 });
    for (let y = 0; y < 40; y++) for (let x = 30; x < 100; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 19, 39);
    claimRect(s, 2, 20, 0, 29, 29);
    claimRect(s, 1, 20, 30, 29, 39);
    s.players[2].capital = at(s, 25, 3);
    // A short spearhead took x 20..23 of rows 19..21: x 24..29 still joins north and south.
    for (let y = 19; y <= 21; y++) for (let x = 20; x <= 23; x++) setOwner(s, at(s, x, y), 1);
    const u = spawnTankDivision(s, 1, at(s, 10, 20));
    u.targetOwner = 2;
    expect(collapsePockets(s, u, at(s, 19, 20), 23, 20)).toBe(0);
    expect(s.map.owner[at(s, 22, 25)]).toBe(2);
  });

  it('a spearhead through the gap cuts the land west of the column off, and it collapses', () => {
    const s = pocketGame();
    const d = spawnTankDivision(s, 1, at(s, 22, 15));
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 30, 15) }).ok).toBe(true);
    let started = false;
    runUntil(s, () => {
      if (d.state === 3) started = true;
      return started && d.state !== 3;
    }, 3000);
    expect(started).toBe(true);
    expect(s.map.owner[at(s, 35, 5)]).toBe(1);
    expect(s.map.owner[at(s, 35, 25)]).toBe(1);
  });
});

describe("'support front' mode", () => {
  it('needs a front; refit needs a Factory; the server validates it', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    // Without a front a player's divisions follow the war target (warTarget.ts); an explicit follow: false needs one.
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support', follow: false }).reason).toMatch(/front/);
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'refit' }).reason).toMatch(/Factory/);
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'charge' as never }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support', front: at(s, 30, 15) }).ok).toBe(true);
    expect(d.mode).toBe('support');
    expect(d.station).toBe(at(s, 30, 15));
    expect(validateAction({ type: 'setDivisionMode', unitIds: [3], mode: 'support', front: 12 })).toEqual({ ok: true, value: { type: 'setDivisionMode', unitIds: [3], mode: 'support', front: 12 } });
    expect(validateAction({ type: 'setDivisionMode', unitIds: [3], mode: 'hold' }).ok).toBe(true);
    expect(validateAction({ type: 'setDivisionMode', unitIds: [3], mode: 'rush' }).ok).toBe(false);
  });

  it('holds behind the front at peace, and launches a spearhead by itself once at war', () => {
    const s = landGame();
    const d = spawnTankDivision(s, 1, at(s, 5, 15));
    applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support', front: at(s, 30, 15) });
    run(s, 200);
    expect(d.state).toBe(0);
    expect(d.x).toBeGreaterThan(15); // drove up to the front
    // We attack player 2 elsewhere (a war).
    expect(applyAction(s, 1, { type: 'attack', tile: at(s, 30, 2), troops: { infantry: 5000, armor: 0, artillery: 0 } }).ok).toBe(true);
    let launched = false;
    runUntil(s, () => (launched = d.state === 2 || d.state === 3), 200);
    expect(launched).toBe(true);
  });

  it('a worn-down division drives back to a Factory to refit', () => {
    const s = landGame();
    const f = addBuilding(s, 'factory', 1, at(s, 3, 3));
    const d = spawnTankDivision(s, 1, at(s, 25, 15));
    for (const k of ['armor', 'infantry', 'artillery'] as const) d.troops[k] *= 0.3;
    applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support', front: at(s, 30, 15) });
    runUntil(s, () => d.state === 1, 100);
    expect(d.state).toBe(1);
    expect(d.target).toBe(f.tile);
  });
});

describe('AI armor and determinism', () => {
  it('an AI at war puts its divisions on support at that front', () => {
    const s = landGame();
    const ai = s.players[1];
    ai.isHuman = false;
    ai.personality = 'warlord';
    s.admin!.aiFrozen = false; // no ticks here: only the calls below act
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    const act = (a: Action) => applyAction(s, 1, a);
    aiDivisionModes(s, 1, act);
    expect(d.mode ?? 'hold').toBe('hold');
    expect(applyAction(s, 2, { type: 'attack', tile: at(s, 29, 15), troops: { infantry: 5000, armor: 0, artillery: 0 } }).ok).toBe(true);
    aiDivisionModes(s, 1, act);
    expect(d.mode).toBe('support');
    expect(s.map.owner[d.station!]).toBe(2);
  });

  it('is deterministic', () => {
    const go = (): number => {
      const s = landGame(9);
      addBuilding(s, 'factory', 1, at(s, 10, 15), 2);
      const a = spawnTankDivision(s, 1, at(s, 20, 10));
      const b = spawnTankDivision(s, 1, at(s, 20, 20));
      applyAction(s, 1, { type: 'setDivisionMode', unitIds: [a.id, b.id], mode: 'support', front: at(s, 30, 15) });
      applyAction(s, 1, { type: 'attack', tile: at(s, 30, 2), troops: { infantry: 5000, armor: 0, artillery: 0 } });
      run(s, 600);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});
