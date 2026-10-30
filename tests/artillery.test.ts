// Artillery's role: siege and attrition. It should break fortified rough ground clearly better than the same number
// of troops without it, while armor stays the open-ground breakthrough arm.
import { describe, expect, it } from 'vitest';
import { barrageKill } from '../src/sim/barrage';
import { markBuildingsChanged } from '../src/sim/buildings';
import { artillerySiegeBonus, launchAttack, updateAttacks, updateSupply } from '../src/sim/combat';
import { ARTILLERY_FORT_BONUS, BARRAGE_KILL_ARMY_SHARE, FORT_DEFENSE, WATCHTOWER_DEF } from '../src/sim/config';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, Troops } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

function addBuilding(s: GameState, owner: number, tile: number, type: BuildingType): void {
  const id = s.nextId++;
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
}

const TAKE = 100;

/**
 * Player 1 (10 columns) attacks player 2 (90 columns, 27 000 infantry) on `terrain` with `force` until it is spent;
 * with `forts`, three real level-1 forts cover all of player 2's land. Returns the tiles taken and the seconds it
 * took to take the first TAKE tiles (Infinity if it never got there).
 */
function siege(terrain: number, force: Troops, forts: boolean): { tiles: number; seconds: number } {
  const s = makeFlatGame(100, 30, 2, { terrain });
  const w = s.map.width;
  claimRect(s, 1, 0, 0, 9, 29);
  claimRect(s, 2, 10, 0, 99, 29);
  s.players[1].troops = { ...force };
  s.players[1].oil = 1e6;
  s.players[2].troops = { infantry: 27000, armor: 0, artillery: 0 };
  if (forts) for (const x of [25, 55, 85]) addBuilding(s, 2, 15 * w + x, 'fort');
  markBuildingsChanged(s);
  const before = s.players[1].tiles;
  expect(launchAttack(s, 1, 15 * w + 10, force).ok).toBe(true);
  let seconds = Infinity;
  for (let k = 0; k < 30000 && s.attacks.length; k++) {
    updateSupply(s);
    updateAttacks(s);
    s.tick++;
    if (seconds === Infinity && s.players[1].tiles - before >= TAKE) seconds = k / 10;
  }
  expect(s.attacks.length).toBe(0);
  expect(s.players[2].alive).toBe(true);
  return { tiles: s.players[1].tiles - before, seconds };
}

const N = 40000;
const mix = (infantry: number, armor: number, artillery: number): Troops => ({ infantry: N * infantry, armor: N * armor, artillery: N * artillery });

describe('artillery: siege and attrition', () => {
  it('a mixed army with artillery takes fortified hills faster and cheaper than the same troops without it', () => {
    const withGuns = siege(Terrain.Hills, mix(0.7, 0, 0.3), true);
    const infantry = siege(Terrain.Hills, mix(1, 0, 0), true);
    const withArmor = siege(Terrain.Hills, mix(0.7, 0.3, 0), true);
    // Cheaper: many more tiles for the same troops.
    expect(withGuns.tiles).toBeGreaterThan(infantry.tiles * 3);
    expect(withGuns.tiles).toBeGreaterThan(withArmor.tiles * 1.6);
    // Faster: the guns get through the first tiles sooner (the others may not get there at all).
    expect(withGuns.seconds).toBeLessThan(Infinity);
    expect(withGuns.seconds).toBeLessThan(Math.min(infantry.seconds, withArmor.seconds));
  });

  it('armor still wins the open-ground breakthrough', () => {
    const guns = siege(Terrain.Plains, mix(0, 0, 1), false);
    const armor = siege(Terrain.Plains, mix(0, 1, 0), false);
    expect(guns.tiles).toBeLessThan(armor.tiles * 0.8);
    expect(armor.seconds).toBeLessThan(guns.seconds);
    // Mixed the same way, the armor mix also beats the artillery mix in the open.
    expect(siege(Terrain.Plains, mix(0.7, 0.3, 0), false).tiles).toBeGreaterThan(siege(Terrain.Plains, mix(0.7, 0, 0.3), false).tiles);
  });

  it('the siege bonus: full under a fort, part of it under a watchtower, none in the open', () => {
    expect(artillerySiegeBonus(1)).toBe(1);
    expect(artillerySiegeBonus(FORT_DEFENSE)).toBeCloseTo(ARTILLERY_FORT_BONUS, 9);
    expect(artillerySiegeBonus(FORT_DEFENSE * WATCHTOWER_DEF)).toBeCloseTo(ARTILLERY_FORT_BONUS, 9);
    const tower = artillerySiegeBonus(WATCHTOWER_DEF);
    expect(tower).toBeGreaterThan(1.2);
    expect(tower).toBeLessThan(ARTILLERY_FORT_BONUS);
  });

  it('barrages matter at grand scale: a 1M-gun battery kills about 1% of a 10M army per shot', () => {
    expect(barrageKill(1e6) / 1e7).toBeGreaterThan(0.008);
    expect(barrageKill(1e6) / 1e7).toBeLessThanOrEqual(BARRAGE_KILL_ARMY_SHARE);
    // Small batteries: still a fraction of the guns, not a free army wipe.
    expect(barrageKill(5000)).toBeLessThan(5000 * 0.3);
  });
});
