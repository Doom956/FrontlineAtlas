// Forts are supply sources (the Supply Depot was removed): a finished fort near a far front supplies it, an unfinished
// or lost one does not, a depot order is refused, and reading supply between ticks never changes the game.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { buildingsOf, markBuildingsChanged, supplySources } from '../src/sim/buildings';
import { estimateAttack, supplyEfficiency, supplySourceTiles } from '../src/sim/combat';
import { BUILDINGS, BUILDING_ORDER, TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { setOwner } from '../src/sim/state';
import type { Action, BuildingType, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const W = 600;
const H = 20;
const at = (x: number, y: number): number => y * W + x;
const FRONT = at(300, 10); // player 2's first column, ~295 tiles from player 1's capital

/** Player 1 (human) owns x 0..299 with its capital at the far west end; player 2 owns x 300..599 (no early win). */
function farFront(): GameState {
  const s = makeFlatGame(W, H, 2, { human: true });
  claimRect(s, 1, 0, 0, 299, H - 1);
  claimRect(s, 2, 300, 0, W - 1, H - 1);
  s.players[1].capital = at(3, 10);
  s.players[1].gold = 1e6;
  s.players[1].iron = 1e4;
  return s;
}

/** Ticks until player 1's first fort is finished (fails after the build time plus a margin). */
function finishFort(s: GameState): void {
  const limit = s.tick + BUILDINGS.fort.buildTime * TICKS_PER_SECOND * 4 + 50;
  while (s.tick < limit && !buildingsOf(s, 1, 'fort').some((b) => b.buildLeft <= 0)) tick(s);
}

describe('forts supply far fronts', () => {
  it('a finished fort near a front makes it supplied; unfinished or lost forts do not', () => {
    const s = farFront();
    expect(supplyEfficiency(s, 1, FRONT)).toBeLessThan(0.6);
    expect(applyAction(s, 1, { type: 'build', building: 'fort', tile: at(288, 10) }).ok).toBe(true);
    const fort = buildingsOf(s, 1, 'fort')[0];
    expect(fort.buildLeft).toBeGreaterThan(0);
    // Under construction: not a source yet.
    expect(supplySources(s, 1)).not.toContain(fort.tile);
    expect(supplyEfficiency(s, 1, FRONT)).toBeLessThan(0.6);
    finishFort(s);
    expect(fort.buildLeft).toBeLessThanOrEqual(0);
    expect(supplySources(s, 1)).toContain(fort.tile);
    expect(supplySourceTiles(s, 1)).toContain(fort.tile);
    expect(supplyEfficiency(s, 1, FRONT)).toBe(1);
    // Supplied attacks are cheaper, by the supply factor alone (no depot bonus on top any more).
    const inf = { infantry: 1000, armor: 0, artillery: 0 };
    const supplied = estimateAttack(s, 1, FRONT, inf)!;
    fort.buildLeft = 1;
    markBuildingsChanged(s);
    const unsupplied = estimateAttack(s, 1, FRONT, inf)!;
    const eff = supplyEfficiency(s, 1, FRONT);
    expect(eff).toBeLessThan(0.6);
    fort.buildLeft = 0;
    markBuildingsChanged(s);
    expect(supplyEfficiency(s, 1, FRONT)).toBe(1);
    expect(supplied.lossPerTile).toBeCloseTo(unsupplied.lossPerTile * eff, 6);
    // A fort on a tile we no longer own supplies nothing (owners are checked on use, not in the cached list).
    setOwner(s, fort.tile, 2);
    expect(supplyEfficiency(s, 1, FRONT)).toBeLessThan(0.6);
    setOwner(s, fort.tile, 1);
    expect(supplyEfficiency(s, 1, FRONT)).toBe(1);
    // Demolished: gone from the sources.
    s.buildings.delete(fort.id);
    s.map.building[fort.tile] = 0;
    markBuildingsChanged(s);
    expect(supplySources(s, 1)).not.toContain(fort.tile);
    expect(supplyEfficiency(s, 1, FRONT)).toBeLessThan(0.6);
  });
});

describe('the Supply Depot is gone', () => {
  it('is no building type, and a depot order is refused without changing the game', () => {
    expect('supplyDepot' in BUILDINGS).toBe(false);
    expect(BUILDING_ORDER).not.toContain('supplyDepot' as BuildingType);
    expect(BUILDING_ORDER.length).toBe(16);
    const s = farFront();
    const h = hashState(s);
    const gold = s.players[1].gold;
    for (const a of [
      { type: 'build', building: 'supplyDepot', tile: at(288, 10) },
      { type: 'buildMany', building: 'supplyDepot', tile: at(288, 10), count: 2 },
      { type: 'upgradeArea', tile: at(288, 10), radius: 10, building: 'supplyDepot', levels: 1 },
    ] as unknown as Action[]) {
      expect(applyAction(s, 1, a).ok).toBe(false);
    }
    expect(s.buildings.size).toBe(0);
    expect(s.players[1].gold).toBe(gold);
    expect(hashState(s)).toBe(h);
  });

  it('hotkeys stay unique', () => {
    const keys = BUILDING_ORDER.map((b) => BUILDINGS[b].hotkey.toUpperCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('supply forts are deterministic', () => {
  /** Same orders in both games; `reads` reads supply all along the front before every tick (like a HUD). */
  function play(reads: boolean): number[] {
    const s = farFront();
    const hashes: number[] = [];
    for (let n = 0; n < 260; n++) {
      if (reads) {
        supplySourceTiles(s, 1);
        for (let y = 0; y < H; y += 3) for (const x of [150, 250, 299, 300, 320]) supplyEfficiency(s, 1, at(x, y));
      }
      if (n === 2) applyAction(s, 1, { type: 'build', building: 'fort', tile: at(288, 10) });
      if (n % 60 === 30) applyAction(s, 1, { type: 'attack', tile: FRONT, troops: { infantry: s.players[1].troops.infantry * 0.3, armor: 0, artillery: 0 } });
      tick(s);
      if (n % 20 === 19) hashes.push(hashState(s));
    }
    expect(buildingsOf(s, 1, 'fort').some((b) => b.buildLeft <= 0)).toBe(true);
    return hashes;
  }

  it('reading supply between ticks never changes the game', () => {
    const quiet = play(false);
    const live = play(true);
    expect(live).toEqual(quiet);
    expect(play(false)).toEqual(quiet);
  });
});
