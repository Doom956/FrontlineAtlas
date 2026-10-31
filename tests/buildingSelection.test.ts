// Upgrading a box selection of buildings: Action upgradeBuildings (src/sim/bulkbuild.ts), the client's selection
// helpers (src/client/selection.ts) and the bar's texts (src/client/hud/buildingSelection.ts).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { buildingAt, buildingCostAfter, buildingMaxLevel, buildTimeFor, updateBuildings } from '../src/sim/buildings';
import { effectiveLevel, updateBuildQueues, upgradeBuildingsPreview } from '../src/sim/bulkbuild';
import { BUILDINGS, TICKS_PER_SECOND, UPGRADE_SELECTION_MAX } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { validateAction } from '../server/validate';
import {
  activeBuildings,
  boxBuildingSelection,
  buildingsInRect,
  buildingTypeCounts,
  nextUpgradeLevels,
  NO_BUILDING_SEL,
  pruneBuildingSelection,
  toggleBuildingType,
  upgradeSelectionAction,
} from '../src/client/selection';
import { upgradeLine } from '../src/client/hud/buildingSelection';
import { claimRect, makeFlatGame } from './helpers';
import type { BuildingType, GameState } from '../src/sim/types';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function run(s: GameState, seconds: number): void {
  for (let k = 0; k < seconds * TICKS_PER_SECOND; k++) {
    updateBuildings(s);
    updateBuildQueues(s);
    s.tick++;
  }
}
/** Player 1 (human) owns x 0..59 with five buildings; player 2 owns x 60..79 with a city at (70, 10). */
function town(): GameState {
  const s = makeFlatGame(80, 60, 2, { human: true });
  claimRect(s, 1, 0, 0, 59, 59);
  claimRect(s, 2, 60, 0, 79, 59);
  s.players[1].gold = 1e7;
  s.players[1].iron = 1e5;
  s.players[2].gold = 1e7;
  s.players[2].iron = 1e5;
  const list: [number, number, BuildingType, number][] = [
    [8, 8, 'city', 1],
    [8, 40, 'city', 1],
    [25, 8, 'farm', 1],
    [25, 40, 'farm', 1],
    [45, 25, 'market', 1],
    [70, 10, 'city', 2],
  ];
  for (const [x, y, type, pid] of list) expect(applyAction(s, pid, { type: 'build', building: type, tile: at(s, x, y) }).ok).toBe(true);
  run(s, 30);
  for (const b of s.buildings.values()) expect(b.buildLeft).toBe(0);
  return s;
}
const tileOf = (s: GameState, x: number, y: number): number => buildingAt(s, at(s, x, y))!.tile;

describe('box selection -> buildings', () => {
  it('picks your buildings inside the box (any corner order), never anyone else\'s', () => {
    const s = town();
    const ids = buildingsInRect(s, 1, 30.4, 45.9, 7.2, 7.5);
    expect(ids.map((id) => s.buildings.get(id)!.type).sort()).toEqual(['city', 'city', 'farm', 'farm']);
    // the whole map: 5 own buildings; the foreign city is never selected
    const all = buildingsInRect(s, 1, 0, 0, 79, 59);
    expect(all.length).toBe(5);
    expect(all.every((id) => s.buildings.get(id)!.owner === 1)).toBe(true);
    expect(buildingsInRect(s, 1, 40, 40, 50, 50)).toEqual([]);
    // a new box replaces the old selection and keeps the x1 / x3 / x5 choice
    const sel = boxBuildingSelection(s, 1, { ids: [99], off: ['farm'], levels: 3 }, 7, 7, 30, 45);
    expect(sel.ids.length).toBe(4);
    expect(sel.off).toEqual([]);
    expect(sel.levels).toBe(3);
  });

  it('filters by type with the chips and prunes lost buildings', () => {
    const s = town();
    let sel = boxBuildingSelection(s, 1, NO_BUILDING_SEL, 0, 0, 59, 59);
    expect(buildingTypeCounts(s, 1, sel)).toEqual([
      { type: 'city', count: 2, on: true },
      { type: 'farm', count: 2, on: true },
      { type: 'market', count: 1, on: true },
    ].sort((a, b) => Object.keys(BUILDINGS).indexOf(a.type) - Object.keys(BUILDINGS).indexOf(b.type)));
    sel = toggleBuildingType(s, 1, sel, 'farm');
    expect(activeBuildings(s, 1, sel).map((b) => b.type).sort()).toEqual(['city', 'city', 'market']);
    sel = toggleBuildingType(s, 1, sel, 'city');
    // switching the last type off switches all back on
    const allOff = toggleBuildingType(s, 1, sel, 'market');
    expect(allOff.off).toEqual([]);
    sel = toggleBuildingType(s, 1, sel, 'farm');
    expect(activeBuildings(s, 1, sel).map((b) => b.type).sort()).toEqual(['farm', 'farm', 'market']);
    // a building that changes hands drops out
    const market = buildingAt(s, at(s, 45, 25))!;
    market.owner = 2;
    const pruned = pruneBuildingSelection(s, 1, sel);
    expect(pruned.ids.length).toBe(4);
    expect(pruneBuildingSelection(s, 1, pruned)).toBe(pruned);
  });

  it('builds the action from the active buildings, capped; Shift+U cycles x1 / x3 / x5', () => {
    const s = town();
    const sel = { ...boxBuildingSelection(s, 1, NO_BUILDING_SEL, 7, 7, 30, 45), off: ['farm'] as BuildingType[] };
    const a = upgradeSelectionAction(s, 1, sel, 3);
    expect(a).toEqual({ type: 'upgradeBuildings', tiles: [tileOf(s, 8, 8), tileOf(s, 8, 40)].sort((x, y) => x - y), levels: 3 });
    expect(upgradeSelectionAction(s, 1, NO_BUILDING_SEL)).toBeNull();
    expect([nextUpgradeLevels(1), nextUpgradeLevels(3), nextUpgradeLevels(5)]).toEqual([3, 5, 1]);
    const many = { ids: Array.from({ length: UPGRADE_SELECTION_MAX + 50 }, () => sel.ids[0]), off: [], levels: 1 as const };
    expect(activeBuildings(s, 1, many).length).toBe(UPGRADE_SELECTION_MAX);
  });
});

describe('Action upgradeBuildings', () => {
  it('queues the levels on each selected building, paid up front, cheapest first', () => {
    const s = town();
    const tiles = [tileOf(s, 8, 8), tileOf(s, 8, 40), tileOf(s, 25, 8)];
    const pv = upgradeBuildingsPreview(s, 1, tiles, 3);
    expect(pv.error).toBeNull();
    expect(pv.buildings).toBe(3);
    expect(pv.levelsQueued).toBe(9);
    expect(pv.shortBy).toEqual({ gold: 0, iron: 0 });
    // the price: each level of a type makes the next one dearer (6 city levels, 3 farm levels)
    let gold = 0;
    for (let k = 0; k < 6; k++) gold += buildingCostAfter(s, 1, 'city', k).gold;
    for (let k = 0; k < 3; k++) gold += buildingCostAfter(s, 1, 'farm', k).gold;
    expect(pv.cost.gold).toBeCloseTo(gold, 6);
    // build time: three levels one after another on the slowest building
    expect(pv.seconds).toBeCloseTo(3 * Math.max(buildTimeFor(s, 1, 'city'), buildTimeFor(s, 1, 'farm')), 6);
    const g0 = s.players[1].gold;
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles, levels: 3 }).ok).toBe(true);
    expect(g0 - s.players[1].gold).toBeCloseTo(pv.cost.gold, 3);
    for (const t of tiles) expect(effectiveLevel(buildingAt(s, t)!)).toBe(4);
    // others untouched
    expect(effectiveLevel(buildingAt(s, at(s, 25, 40))!)).toBe(1);
    // levels are still built one by one with their normal time
    const city = buildingAt(s, tiles[0])!;
    run(s, buildTimeFor(s, 1, 'city') + 0.5);
    expect(city.level).toBe(2);
    run(s, 2 * buildTimeFor(s, 1, 'city') + 1);
    expect(city.level).toBe(4);
    expect(city.queuedLevels).toBe(0);
  });

  it('orders only what the money covers, cheapest levels first, and says what is short', () => {
    const s = town();
    const tiles = [tileOf(s, 8, 8), tileOf(s, 25, 8), tileOf(s, 25, 40)];
    s.players[1].gold = buildingCostAfter(s, 1, 'farm', 0).gold + buildingCostAfter(s, 1, 'farm', 1).gold + 1;
    const pv = upgradeBuildingsPreview(s, 1, tiles, 1);
    expect(pv.error).toBeNull();
    expect(pv.levelsQueued).toBe(2);
    expect(pv.plan.every((e) => e.type === 'farm')).toBe(true);
    expect(pv.shortBy.gold).toBeGreaterThan(0);
    expect(upgradeLine(pv, 1).tone).toBe('short');
    s.players[1].gold = 1;
    const none = upgradeBuildingsPreview(s, 1, tiles, 1);
    expect(none.error).toMatch(/^Not enough gold/);
    expect(upgradeLine(none, 1).tone).toBe('no');
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles, levels: 1 }).ok).toBe(false);
    expect(s.players[1].gold).toBe(1);
  });

  it('rejects other players\' buildings and bad parameters; skips foreign tiles in a mixed order', () => {
    const s = town();
    const foreign = tileOf(s, 70, 10);
    const g2 = s.players[2].gold;
    const g1 = s.players[1].gold;
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: [foreign], levels: 1 }).reason).toMatch(/None of these buildings is yours/);
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: [at(s, 40, 40)], levels: 1 }).ok).toBe(false);
    const mine = tileOf(s, 8, 8);
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: [foreign, mine], levels: 1 }).ok).toBe(true);
    expect(effectiveLevel(buildingAt(s, foreign)!)).toBe(1);
    expect(effectiveLevel(buildingAt(s, mine)!)).toBe(2);
    expect(s.players[2].gold).toBe(g2);
    expect(s.players[1].gold).toBeLessThan(g1);
    // levels other than 1, 3, 5; bad tiles; empty or too long lists
    for (const levels of [0, 2, 4, 6, 1.5, NaN]) expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: [mine], levels } as never).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: [-1], levels: 1 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: [s.map.width * s.map.height], levels: 1 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: [], levels: 1 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'upgradeBuildings', tiles: Array.from({ length: UPGRADE_SELECTION_MAX + 1 }, () => mine), levels: 1 }).ok).toBe(false);
    // the same tile twice counts once
    const pv = upgradeBuildingsPreview(s, 1, [mine, mine], 1);
    expect(pv.buildings).toBe(1);
  });

  it('refuses buildings at their top level', () => {
    const s = town();
    const farm = buildingAt(s, at(s, 25, 8))!;
    farm.level = buildingMaxLevel('farm');
    const pv = upgradeBuildingsPreview(s, 1, [farm.tile], 5);
    expect(pv.error).toMatch(/highest level/);
    expect(pv.maxed).toBe(1);
    // with another building: the maxed one is skipped, the other gets its levels
    const both = upgradeBuildingsPreview(s, 1, [farm.tile, tileOf(s, 25, 40)], 1);
    expect(both.error).toBeNull();
    expect(both.plan.map((e) => e.tile)).toEqual([tileOf(s, 25, 40)]);
  });

  it('the server accepts the shape and only that', () => {
    expect(validateAction({ type: 'upgradeBuildings', tiles: [5, 9], levels: 3 }).ok).toBe(true);
    expect(validateAction({ type: 'upgradeBuildings', tiles: [], levels: 1 }).ok).toBe(false);
    expect(validateAction({ type: 'upgradeBuildings', tiles: [5, 5], levels: 1 }).ok).toBe(false);
    expect(validateAction({ type: 'upgradeBuildings', tiles: [-3], levels: 1 }).ok).toBe(false);
    expect(validateAction({ type: 'upgradeBuildings', tiles: [1.5], levels: 1 }).ok).toBe(false);
    expect(validateAction({ type: 'upgradeBuildings', tiles: 'x', levels: 1 } as never).ok).toBe(false);
    expect(validateAction({ type: 'upgradeBuildings', tiles: Array.from({ length: UPGRADE_SELECTION_MAX + 1 }, (_, k) => k), levels: 1 }).ok).toBe(false);
  });

  it('is deterministic: the same order on two copies gives the same hash', () => {
    const go = (): string => {
      const s = town();
      const tiles = buildingsInRect(s, 1, 0, 0, 59, 59).map((id) => s.buildings.get(id)!.tile);
      s.players[1].gold = 3000;
      applyAction(s, 1, { type: 'upgradeBuildings', tiles, levels: 5 });
      run(s, 20);
      return String(hashState(s));
    };
    expect(go()).toBe(go());
  });
});
