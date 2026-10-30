// Bulk build and area upgrades (src/sim/bulkbuild.ts).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { buildingAt, buildingCost, buildingsOf, demolish, updateBuildings } from '../src/sim/buildings';
import { buildManyPreview, effectiveLevel, updateBuildQueues, upgradeAreaPreview } from '../src/sim/bulkbuild';
import { BUILDING_DEMOLISH_REFUND, BUILDINGS, TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { setOwner } from '../src/sim/state';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame } from './helpers';
import type { GameState } from '../src/sim/types';

function game(gold = 1e6): GameState {
  const s = makeFlatGame(80, 60, 2, { human: true });
  claimRect(s, 1, 0, 0, 59, 59);
  claimRect(s, 2, 60, 0, 79, 59);
  s.players[1].gold = gold;
  s.players[1].iron = 1e5;
  return s;
}
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
/** Runs construction / queues for `seconds` (only buildings, so nothing else interferes). */
function run(s: GameState, seconds: number): void {
  for (let k = 0; k < seconds * TICKS_PER_SECOND; k++) {
    updateBuildings(s);
    updateBuildQueues(s);
    s.tick++;
  }
}

describe('buildMany', () => {
  it('places a city and queues it straight to level 5, one level after another', () => {
    const s = game();
    const tile = at(s, 20, 20);
    const pv = buildManyPreview(s, 1, 'city', tile, 5);
    expect(pv.error).toBeNull();
    expect(pv.upgrade).toBe(false);
    expect(pv.levelsQueued).toBe(5);
    expect(pv.toLevel).toBe(5);
    expect(pv.shortBy).toEqual({ gold: 0, iron: 0 });
    const g0 = s.players[1].gold;
    expect(applyAction(s, 1, { type: 'buildMany', building: 'city', tile, count: 5 }).ok).toBe(true);
    expect(g0 - s.players[1].gold).toBeCloseTo(pv.cost.gold);
    const b = buildingAt(s, pv.tile)!;
    expect(b.level).toBe(1);
    expect(b.queuedLevels).toBe(4);
    expect(effectiveLevel(b)).toBe(5);
    // Each level takes its normal time: after construction + 1 upgrade it is level 2, not more.
    const t = BUILDINGS.city.buildTime;
    run(s, t + 0.5);
    expect(b.level).toBe(1);
    expect(b.upgradeLeft).toBeGreaterThan(0);
    run(s, t);
    expect(b.level).toBe(2);
    run(s, t * 3 + 1);
    expect(b.level).toBe(5);
    expect(b.queuedLevels).toBe(0);
    expect(b.queuedPaid).toBeUndefined();
  });
  it('the same total price as single orders, and queues only what it can afford', () => {
    const s = game();
    const tile = at(s, 20, 20);
    let sum = 0;
    const single = game();
    for (let k = 0; k < 3; k++) {
      sum += buildingCost(single, 1, 'city').gold;
      // a single order of each next level (fake the levels so the price basis matches)
      if (k === 0) applyAction(single, 1, { type: 'build', building: 'city', tile });
      else {
        const b = buildingAt(single, tile)!;
        b.buildLeft = 0;
        b.upgradeLeft = 0;
        applyAction(single, 1, { type: 'build', building: 'city', tile });
      }
    }
    expect(buildManyPreview(s, 1, 'city', tile, 3).cost.gold).toBe(sum);
    const poor = game(buildingCost(s, 1, 'city').gold * 2.6);
    const pv = buildManyPreview(poor, 1, 'city', tile, 5);
    expect(pv.levelsQueued).toBe(2);
    expect(pv.shortBy.gold).toBeGreaterThan(0);
    expect(applyAction(poor, 1, { type: 'buildMany', building: 'city', tile, count: 5 }).ok).toBe(true);
    expect(effectiveLevel(buildingAt(poor, pv.tile)!)).toBe(2);
    expect(poor.events.some((e) => /could afford 2 of 5/.test(e.message))).toBe(true);
  });
  it('adds levels to an existing building, even while it is busy, up to the top level', () => {
    const s = game();
    const tile = at(s, 20, 20);
    applyAction(s, 1, { type: 'build', building: 'market', tile });
    const b = buildingAt(s, tile)!;
    expect(b.buildLeft).toBeGreaterThan(0);
    const pv = buildManyPreview(s, 1, 'market', at(s, 22, 21), 5);
    expect(pv.upgrade).toBe(true);
    expect(pv.requested).toBe(BUILDINGS.market.maxLevel - 1);
    expect(applyAction(s, 1, { type: 'buildMany', building: 'market', tile: at(s, 22, 21), count: 5 }).ok).toBe(true);
    expect(effectiveLevel(b)).toBe(BUILDINGS.market.maxLevel);
    expect(applyAction(s, 1, { type: 'buildMany', building: 'market', tile, count: 1 }).reason).toMatch(/highest level/);
  });
  it('refuses bad counts, unknown buildings, foreign land and no money', () => {
    const s = game();
    expect(applyAction(s, 1, { type: 'buildMany', building: 'city', tile: at(s, 20, 20), count: 6 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'buildMany', building: 'city', tile: at(s, 20, 20), count: 0 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'buildMany', building: 'city', tile: at(s, 20, 20), count: 2.5 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'buildMany', building: 'castle' as never, tile: at(s, 20, 20), count: 2 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'buildMany', building: 'city', tile: at(s, 75, 20), count: 2 }).ok).toBe(false);
    s.players[1].gold = 0;
    expect(applyAction(s, 1, { type: 'buildMany', building: 'city', tile: at(s, 20, 20), count: 2 }).reason).toMatch(/Not enough gold/);
  });
});

describe('cancel, demolish, capture', () => {
  it('cancelling refunds the queued levels exactly', () => {
    const s = game();
    const g0 = s.players[1].gold;
    applyAction(s, 1, { type: 'buildMany', building: 'city', tile: at(s, 20, 20), count: 4 });
    const b = buildingsOf(s, 1, 'city')[0];
    const first = buildingCost(game(), 1, 'city').gold;
    expect(applyAction(s, 1, { type: 'cancelQueuedLevels', tile: b.tile }).ok).toBe(true);
    expect(b.queuedLevels).toBe(0);
    expect(g0 - s.players[1].gold).toBeCloseTo(first);
    expect(applyAction(s, 1, { type: 'cancelQueuedLevels', tile: b.tile }).reason).toMatch(/No levels/);
    expect(applyAction(s, 2, { type: 'cancelQueuedLevels', tile: b.tile }).ok).toBe(false);
  });
  it('demolishing refunds queued levels in full; a capture drops the queue', () => {
    const s = game();
    applyAction(s, 1, { type: 'buildMany', building: 'farm', tile: at(s, 20, 20), count: 3 });
    const b = buildingsOf(s, 1, 'farm')[0];
    const paid = b.queuedPaid!.gold;
    const g = s.players[1].gold;
    demolish(s, 1, b.tile);
    expect(s.players[1].gold - g).toBeCloseTo(paid + BUILDINGS.farm.cost * 1 * BUILDING_DEMOLISH_REFUND, 0);
    applyAction(s, 1, { type: 'buildMany', building: 'farm', tile: at(s, 30, 30), count: 3 });
    const c = buildingsOf(s, 1, 'farm')[0];
    expect(c.queuedLevels).toBe(2);
    setOwner(s, c.tile, 2);
    expect(c.owner).toBe(2);
    expect(c.queuedLevels).toBe(0);
  });
});

describe('upgradeArea', () => {
  function withTown(): GameState {
    const s = game();
    s.players[1].gold = 1e7;
    for (const [x, y, type] of [[10, 10, 'city'], [30, 10, 'market'], [10, 30, 'farm'], [30, 30, 'farm'], [55, 55, 'city']] as const) {
      applyAction(s, 1, { type: 'build', building: type, tile: at(s, x, y) });
    }
    run(s, 20);
    return s;
  }
  it('queues levels for every own building in the radius (optionally one type), cheapest first', () => {
    const s = withTown();
    const all = upgradeAreaPreview(s, 1, at(s, 20, 20), 20, undefined, 2);
    expect(all.error).toBeNull();
    expect(all.candidates).toBe(4); // the far city at (55, 55) is outside
    expect(all.levelsQueued).toBe(8);
    const farms = upgradeAreaPreview(s, 1, at(s, 20, 20), 20, 'farm', 3);
    expect(farms.buildings).toBe(2);
    expect(farms.levelsQueued).toBe(6);
    // Money for only a few levels: the cheap farm levels go first.
    s.players[1].gold = BUILDINGS.farm.cost * 4;
    const few = upgradeAreaPreview(s, 1, at(s, 20, 20), 20, undefined, 2);
    expect(few.levelsQueued).toBeGreaterThan(0);
    expect(few.plan.every((e) => e.type === 'farm')).toBe(true);
    expect(few.shortBy.gold).toBeGreaterThan(0);
    const g0 = s.players[1].gold;
    expect(applyAction(s, 1, { type: 'upgradeArea', tile: at(s, 20, 20), radius: 20, levels: 2 }).ok).toBe(true);
    expect(g0 - s.players[1].gold).toBeCloseTo(few.cost.gold, 3);
  });
  it('refuses empty areas and bad parameters; the server accepts the shape', () => {
    const s = withTown();
    expect(applyAction(s, 1, { type: 'upgradeArea', tile: at(s, 45, 45), radius: 3, levels: 1 }).reason).toMatch(/No building/);
    expect(applyAction(s, 1, { type: 'upgradeArea', tile: at(s, 20, 20), radius: 20, levels: 9 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'upgradeArea', tile: at(s, 20, 20), radius: NaN, levels: 1 }).ok).toBe(false);
    expect(validateAction({ type: 'upgradeArea', tile: 5, radius: 10, levels: 2 }).ok).toBe(true);
    expect(validateAction({ type: 'upgradeArea', tile: 5, radius: 10, levels: 2, building: 'farm' }).ok).toBe(true);
    expect(validateAction({ type: 'upgradeArea', tile: 5, radius: 10, levels: 2, building: 'castle' }).ok).toBe(false);
    expect(validateAction({ type: 'buildMany', building: 'city', tile: 5, count: 3 }).ok).toBe(true);
    expect(validateAction({ type: 'cancelQueuedLevels', tile: 5 }).ok).toBe(true);
  });
});

describe('determinism', () => {
  it('bulk orders hash the same on two runs and change the hash', () => {
    const go = (bulk: boolean) => {
      const s = game();
      if (bulk) applyAction(s, 1, { type: 'buildMany', building: 'city', tile: at(s, 20, 20), count: 4 });
      else applyAction(s, 1, { type: 'build', building: 'city', tile: at(s, 20, 20) });
      for (let k = 0; k < 200; k++) tick(s);
      return hashState(s);
    };
    expect(go(true)).toBe(go(true));
    expect(go(true)).not.toBe(go(false));
  });
});
