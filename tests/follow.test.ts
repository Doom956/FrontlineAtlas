// Follow my war (warTarget.ts): war target, air wings, warships, tank divisions and auto recon retarget to it.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { wingOf } from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { frontTiles } from '../src/sim/combat';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { buildAircraft, spawnWarshipAt } from '../src/sim/units';
import { autoReconOn, followTargetOf, followedNation, FOLLOW_MEMORY_SECONDS, mainFront, warTargetOf } from '../src/sim/warTarget';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/**
 * 120 x 40: land y 0..19 (AI 2 x 0..39, the human 1 x 40..79, AI 3 x 80..119), sea y 20..39. AIs frozen, so only
 * our orders act; rich, with Flight, Navigation, Mechanization and Recon Planes for player 1.
 */
function game(seed = 5): GameState {
  const s = makeFlatGame(120, 40, 3, { human: true, seed });
  for (let y = 20; y < 40; y++) for (let x = 0; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 2, 0, 0, 39, 19);
  claimRect(s, 1, 40, 0, 79, 19);
  claimRect(s, 3, 80, 0, 119, 19);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.troops = { infantry: p.id === 1 ? 400000 : 60000, armor: 0, artillery: 0 };
  }
  s.players[1].techs.push('flight', 'navigation', 'mechanization', 'reconPlanes');
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
function runUntil(s: GameState, pred: () => boolean, max = 1500): boolean {
  for (let k = 0; k < max; k++) {
    if (pred()) return true;
    tick(s);
  }
  return pred();
}
/** Player 1 attacks nation `foe` across the shared border with `troops` infantry. */
function attack(s: GameState, foe: 2 | 3, troops: number): void {
  const border = frontTiles(s, 1, foe);
  const tile = border[Math.floor(border.length / 2)];
  const r = applyAction(s, 1, { type: 'attack', tile, troops: { infantry: troops, armor: 0, artillery: 0 } });
  expect(r.reason ?? '').toBe('');
}
function stopAttacks(s: GameState): void {
  for (const a of s.attacks.filter((q) => q.attacker === 1)) applyAction(s, 1, { type: 'retreat', attackId: a.id });
}
function airfield(s: GameState, bombers: number, fighters = 0): Building {
  const b = addBuilding(s, 'airfield', 1, at(s, 60, 10), 2);
  for (let k = 0; k < bombers; k++) expect(buildAircraft(s, 1, b.tile, 'bomber').ok).toBe(true);
  for (let k = 0; k < fighters; k++) expect(buildAircraft(s, 1, b.tile, 'fighter').ok).toBe(true);
  return b;
}
/** Owners of the tiles player 1's bombers launched after `since` (unit id) fly to. */
function bomberTargets(s: GameState, since: number): number[] {
  return s.units.filter((u) => u.type === 'bomber' && u.owner === 1 && u.id > since && u.cargo === 0).map((u) => s.map.owner[u.target]);
}
const EVERY = 2 * TICKS_PER_SECOND;
const lastId = (s: GameState): number => s.units.reduce((m, u) => Math.max(m, u.id), 0);

describe('war target', () => {
  it('follows the attack with the most troops and switches when the player attacks someone else', () => {
    const s = game();
    expect(followedNation(s, 1)).toBe(0);
    // Two attacks running at the next check: the bigger one wins.
    run(s, EVERY - 1 - (s.tick % EVERY));
    attack(s, 2, 20000);
    attack(s, 3, 60000);
    run(s, 2);
    expect(followedNation(s, 1)).toBe(3);
    expect(warTargetOf(s, 1)).toMatchObject({ nation: 3, attacking: true });
    run(s, EVERY - 1 - (s.tick % EVERY));
    attack(s, 2, 60000);
    attack(s, 3, 20000);
    run(s, 2);
    expect(followedNation(s, 1)).toBe(2);
    expect(s.map.owner[mainFront(s, 1, 2)]).toBe(2);
    // The attacks end; then the player attacks 3: it becomes the war target.
    run(s, 10 * TICKS_PER_SECOND);
    expect(followedNation(s, 1)).toBe(2);
    attack(s, 3, 20000);
    run(s, EVERY + 1);
    expect(followedNation(s, 1)).toBe(3);
    expect(s.map.owner[mainFront(s, 1, 3)]).toBe(3);
    // AI players have no war target (their units keep their own logic).
    expect(followedNation(s, 2)).toBe(0);
  });

  it('falls back to the last nation attacked for a minute, then to nothing', () => {
    const s = game();
    attack(s, 2, 20000);
    run(s, 2 * TICKS_PER_SECOND + 1);
    stopAttacks(s);
    run(s, 5 * TICKS_PER_SECOND);
    expect(followedNation(s, 1)).toBe(2);
    const w = warTargetOf(s, 1);
    expect(w.attacking).toBe(false);
    expect(w.secondsLeft).toBeGreaterThan(40);
    run(s, (FOLLOW_MEMORY_SECONDS + 5) * TICKS_PER_SECOND);
    expect(followedNation(s, 1)).toBe(0);
    expect(warTargetOf(s, 1).nation).toBe(0);
  });
});

describe('air wings', () => {
  it('strategic follows the war target; a picked target fixes it; Follow again goes back', () => {
    const s = game();
    const af = airfield(s, 8, 2);
    // Cities for both nations, rebuilt before each check (bombs destroy buildings by chance).
    const spots: [number, number][] = [[20, 10], [25, 5], [15, 15]];
    const restock = (): void => {
      for (const [x, y] of spots) {
        if (!s.map.building[at(s, x, y)]) addBuilding(s, 'city', 2, at(s, x, y), 3);
        if (!s.map.building[at(s, 119 - x, y)]) addBuilding(s, 'city', 3, at(s, 119 - x, y), 3);
      }
    };
    restock();
    const c2 = s.buildings.get(s.map.building[at(s, 20, 10)] - 1)!;
    // A player's mission without a target follows the war.
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic' }).ok).toBe(true);
    expect(wingOf(s, af)!.follow).toBe(true);
    expect(followTargetOf(s, af)).toMatchObject({ follow: true, nation: 0 });
    // No war target: no sorties.
    run(s, 60);
    expect(bomberTargets(s, 0)).toEqual([]);
    attack(s, 2, 30000);
    let since = lastId(s);
    expect(runUntil(s, () => bomberTargets(s, since).length > 0)).toBe(true);
    expect(new Set(bomberTargets(s, since))).toEqual(new Set([2]));
    // The player turns on nation 3 harder: the next raids go there by themselves.
    attack(s, 3, 90000);
    run(s, 2 * TICKS_PER_SECOND + 1);
    expect(followTargetOf(s, af)).toMatchObject({ follow: true, nation: 3 });
    restock();
    since = lastId(s);
    expect(runUntil(s, () => bomberTargets(s, since).length > 0)).toBe(true);
    expect(new Set(bomberTargets(s, since))).toEqual(new Set([3]));
    // Fixed on nation 2 (a picked city) while the war target stays 3.
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic', target: c2.tile }).ok).toBe(true);
    expect(wingOf(s, af)!.follow).toBeUndefined();
    expect(followTargetOf(s, af)).toMatchObject({ follow: false, nation: 2 });
    // A Fixed raid flies while that war goes on: attack 2 just before the next sortie is due.
    run(s, Math.max(0, wingOf(s, af)!.nextTick - s.tick - 1));
    attack(s, 2, 30000);
    restock();
    since = lastId(s);
    expect(runUntil(s, () => bomberTargets(s, since).length > 0)).toBe(true);
    expect(new Set(bomberTargets(s, since))).toEqual(new Set([2]));
    // Follow again (the war target is 2 now: we attacked it last), then the player attacks 3 again.
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic', follow: true }).ok).toBe(true);
    expect(followTargetOf(s, af)).toMatchObject({ follow: true, nation: 2 });
    attack(s, 3, 30000);
    run(s, EVERY + 1);
    expect(followTargetOf(s, af)).toMatchObject({ follow: true, nation: 3 });
    restock();
    since = lastId(s);
    expect(runUntil(s, () => bomberTargets(s, since).length > 0)).toBe(true);
    expect(new Set(bomberTargets(s, since))).toEqual(new Set([3]));
  });

  it('support bombs the main front and superiority patrols over it; both move when the war target changes', () => {
    const s = game();
    const sup = airfield(s, 8);
    const pat = addBuilding(s, 'airfield', 1, at(s, 60, 4), 2);
    for (let k = 0; k < 4; k++) buildAircraft(s, 1, pat.tile, 'fighter');
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: sup.tile, mission: 'support' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: pat.tile, mission: 'superiority' }).ok).toBe(true);
    expect(wingOf(s, pat)!.target).toBe(-1); // no war: over the airfield
    attack(s, 2, 40000);
    run(s, 5 * TICKS_PER_SECOND);
    const ws = wingOf(s, sup)!;
    const wp = wingOf(s, pat)!;
    expect(s.map.owner[ws.target]).toBe(2);
    expect(wp.target).toBeGreaterThanOrEqual(0);
    expect(s.map.owner[wp.target]).toBe(1);
    expect(wp.target % s.map.width).toBeLessThan(50); // our side of the western front
    attack(s, 3, 120000);
    run(s, 6 * TICKS_PER_SECOND);
    expect(s.map.owner[ws.target]).toBe(3);
    expect(wp.target % s.map.width).toBeGreaterThan(70); // the eastern front
  });

  it('AI missions stay as they were (no follow), and a player can still fix a mission with a target', () => {
    const s = game();
    s.admin!.aiFrozen = false;
    s.players[2].techs.push('flight');
    const ai = addBuilding(s, 'airfield', 2, at(s, 20, 10));
    expect(applyAction(s, 2, { type: 'setAirMission', airfield: ai.tile, mission: 'superiority' }).ok).toBe(true);
    expect(wingOf(s, ai)!.follow).toBeUndefined();
    expect(applyAction(s, 2, { type: 'setAirMission', airfield: ai.tile, mission: 'strategic' }).reason).toMatch(/nation/);
    const af = airfield(s, 2);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', follow: false }).reason).toMatch(/front/);
  });
});

describe('warships', () => {
  function ship(s: GameState): Unit {
    const u = spawnWarshipAt(s, 1, at(s, 60, 19), at(s, 60, 30));
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'bombard' }).ok).toBe(true);
    return u;
  }
  const stationOwner = (s: GameState, u: Unit): number => (u.state === 3 && u.station !== undefined ? s.map.owner[u.station] : -1);

  it("bombard shells the war target's coast, moves when it changes, can be pinned and set back to Follow", () => {
    const s = game();
    const u = ship(s);
    expect(followTargetOf(s, u)).toMatchObject({ follow: true, nation: 0 });
    attack(s, 2, 30000);
    expect(runUntil(s, () => stationOwner(s, u) === 2, 600)).toBe(true);
    attack(s, 3, 90000);
    expect(runUntil(s, () => stationOwner(s, u) === 3, 900)).toBe(true);
    // Pinned to nation 2 (a tile of its land), while the war target stays 3.
    attack(s, 2, 10000);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'bombard', target: at(s, 10, 10) }).ok).toBe(true);
    expect(u.fixed).toBe(2);
    expect(followTargetOf(s, u)).toMatchObject({ follow: false, nation: 2 });
    expect(runUntil(s, () => stationOwner(s, u) === 2, 900)).toBe(true);
    // A stance change alone keeps the pin; follow: true drops it.
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'blockade' }).ok).toBe(true);
    expect(u.fixed).toBe(2);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'bombard', follow: true }).ok).toBe(true);
    expect(u.fixed).toBeUndefined();
    attack(s, 3, 30000); // the war target was 2 (attacked last)
    expect(runUntil(s, () => stationOwner(s, u) === 3, 900)).toBe(true);
    // Pins only on another nation's land.
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'bombard', target: at(s, 60, 5) }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'bombard', target: at(s, 60, 30) }).ok).toBe(false);
  });
});

describe('tank divisions', () => {
  it('support without a front follows the main front; a picked front fixes it', () => {
    const s = game();
    const d = spawnTankDivision(s, 1, at(s, 60, 10));
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support' }).ok).toBe(true);
    expect(d.mode).toBe('support');
    expect(d.fixed).toBeUndefined();
    run(s, 40);
    expect(d.mode).toBe('support'); // no war target: holds, still on support
    attack(s, 2, 30000);
    run(s, 6 * TICKS_PER_SECOND);
    expect(d.station).toBeDefined();
    expect(d.station! % s.map.width).toBeLessThan(45);
    expect(followTargetOf(s, d)).toMatchObject({ follow: true, nation: 2 });
    attack(s, 3, 90000);
    run(s, 6 * TICKS_PER_SECOND);
    expect(d.station! % s.map.width).toBeGreaterThan(75);
    // Fixed on the western front.
    const west = at(s, 39, 10);
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support', front: west }).ok).toBe(true);
    expect(d.fixed).toBe(1);
    run(s, 6 * TICKS_PER_SECOND);
    expect(d.station).toBe(west);
    expect(followTargetOf(s, d)).toMatchObject({ follow: false, tile: west });
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support', follow: true }).ok).toBe(true);
    expect(d.fixed).toBeUndefined();
    expect(d.station! % s.map.width).toBeGreaterThan(75);
    // AI divisions still need a front.
    s.players[2].techs.push('mechanization');
    s.admin!.aiFrozen = false;
    const ad = spawnTankDivision(s, 2, at(s, 20, 10));
    expect(applyAction(s, 2, { type: 'setDivisionMode', unitIds: [ad.id], mode: 'support' }).reason).toMatch(/front/);
  });
});

describe('auto recon', () => {
  it('is off by default; when on, a ready airfield scouts the war target', () => {
    const s = game();
    const af = airfield(s, 0);
    const recon = (): Unit[] => s.units.filter((u) => u.type === 'reconPlane' && u.owner === 1);
    attack(s, 2, 30000);
    run(s, 40);
    expect(autoReconOn(s, af)).toBe(false);
    expect(recon()).toEqual([]);
    expect(applyAction(s, 1, { type: 'setAutoRecon', airfield: af.tile, on: true }).ok).toBe(true);
    expect(autoReconOn(s, af)).toBe(true);
    expect(runUntil(s, () => recon().length > 0, 60)).toBe(true);
    expect(recon()[0].targetOwner).toBe(2);
    const first = recon()[0].id;
    run(s, 100);
    expect(s.units.some((u) => u.type === 'reconPlane' && u.id > first)).toBe(false); // one flight while its reveal lasts
    expect(applyAction(s, 1, { type: 'setAutoRecon', airfield: -1, on: false }).ok).toBe(true);
    expect(autoReconOn(s, af)).toBe(false);
    // Needs the tech and an own airfield.
    expect(applyAction(s, 1, { type: 'setAutoRecon', airfield: at(s, 61, 10), on: true }).ok).toBe(false);
    s.players[1].techs = s.players[1].techs.filter((t) => t !== 'reconPlanes');
    expect(applyAction(s, 1, { type: 'setAutoRecon', airfield: af.tile, on: true }).reason).toMatch(/Recon Planes/);
  });
});

describe('determinism and validation', () => {
  function scenario(): GameState {
    const s = game(9);
    const af = airfield(s, 6, 2);
    addBuilding(s, 'city', 2, at(s, 20, 10), 2);
    addBuilding(s, 'city', 3, at(s, 100, 10), 2);
    applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic' });
    applyAction(s, 1, { type: 'setAutoRecon', airfield: af.tile, on: true });
    const u = spawnWarshipAt(s, 1, at(s, 60, 19), at(s, 60, 30));
    applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'blockade' });
    const d = spawnTankDivision(s, 1, at(s, 60, 10));
    applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support' });
    attack(s, 2, 30000);
    run(s, 200);
    attack(s, 3, 90000);
    run(s, 400);
    return s;
  }

  it('two runs give the same hash; follow / fixed choices are part of it', () => {
    const a = scenario();
    const b = scenario();
    expect(hashState(a)).toBe(hashState(b));
    const ship = b.units.find((u) => u.type === 'warship')!;
    expect(applyAction(b, 1, { type: 'setUnitStance', unitIds: [ship.id], stance: 'blockade', target: at(b, 10, 10) }).ok).toBe(true);
    expect(hashState(b)).not.toBe(hashState(a));
  });

  it('the server accepts the new fields and drops junk', () => {
    expect(validateAction({ type: 'setAirMission', airfield: -1, mission: 'strategic', follow: true, junk: 1 })).toEqual({
      ok: true,
      value: { type: 'setAirMission', airfield: -1, mission: 'strategic', follow: true },
    });
    expect(validateAction({ type: 'setAirMission', airfield: 5, mission: 'support', follow: 'yes' }).ok).toBe(false);
    expect(validateAction({ type: 'setUnitStance', unitIds: [3], stance: 'bombard', target: 44, follow: false })).toEqual({
      ok: true,
      value: { type: 'setUnitStance', unitIds: [3], stance: 'bombard', target: 44, follow: false },
    });
    expect(validateAction({ type: 'setUnitStance', unitIds: [3], stance: 'bombard', target: -4 }).ok).toBe(false);
    expect(validateAction({ type: 'setDivisionMode', unitIds: [3], mode: 'support', follow: true })).toEqual({
      ok: true,
      value: { type: 'setDivisionMode', unitIds: [3], mode: 'support', follow: true },
    });
    expect(validateAction({ type: 'setAutoRecon', airfield: 12, on: true })).toEqual({ ok: true, value: { type: 'setAutoRecon', airfield: 12, on: true } });
    expect(validateAction({ type: 'setAutoRecon', airfield: -1, on: false }).ok).toBe(true);
    expect(validateAction({ type: 'setAutoRecon', airfield: 12 }).ok).toBe(false);
    expect(validateAction({ type: 'setAutoRecon', airfield: 12, on: 1 }).ok).toBe(false);
  });
});
