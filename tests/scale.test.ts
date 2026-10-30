// Grand scale: the shared contract (tile change feed, buildingsVersion, map sizes and player counts), the
// incremental territory data (border sets, land weights) that replaced full-map scans, boats on a click across
// water, and staggered enclave checks.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { build, markBuildingsChanged, updateBuildings } from '../src/sim/buildings';
import { drainTileChanges, recordTileChange, TILE_CHANGES_CAPACITY } from '../src/sim/changes';
import { boatLandingTile, frontTiles, launchAttack, needsBoat } from '../src/sim/combat';
import {
  BUILDINGS,
  DEFAULT_AI_COUNT,
  DEFAULT_TRIBE_COUNT,
  ENCLAVE_CHECK_SECONDS,
  MAP_SIZES,
  MAX_AI_COUNT,
  MAX_TRIBE_COUNT,
  TERRAIN,
  TICKS_PER_SECOND,
} from '../src/sim/config';
import { updateEndgame } from '../src/sim/endgame';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { makeRng } from '../src/sim/rng';
import { setOwner, tribeCountFor } from '../src/sim/state';
import { borderTiles, landComponents, landWeight } from '../src/sim/territory';
import { Terrain } from '../src/sim/types';
import type { GameState, TerrainId, Troops } from '../src/sim/types';
import { updateUnits } from '../src/sim/units';
import { claimRect, makeFlatGame, testSettings } from './helpers';

const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

describe('shared contract', () => {
  it('map sizes and player counts', () => {
    expect(MAP_SIZES.huge).toEqual({ width: 2600, height: 1600 });
    expect(DEFAULT_AI_COUNT).toEqual({ small: 8, medium: 8, large: 8, huge: 8 });
    expect(DEFAULT_TRIBE_COUNT).toEqual({ small: 120, medium: 200, large: 300, huge: 300 });
    expect(MAX_AI_COUNT).toBe(40);
    expect(MAX_TRIBE_COUNT).toBe(600);
    expect(tribeCountFor(testSettings({ tribeCount: -1, mapSize: 'huge' }))).toBe(300);
    expect(tribeCountFor(testSettings({ tribeCount: -1, mapSize: 'small' }))).toBe(120);
    expect(tribeCountFor(testSettings({ tribeCount: 9999, mapSize: 'huge' }))).toBe(MAX_TRIBE_COUNT);
  });

  it('records every owner change and fallout end; drain returns them once; overflow when full', () => {
    const s = makeFlatGame(20, 10, 2);
    drainTileChanges(s);
    setOwner(s, at(s, 3, 3), 1);
    setOwner(s, at(s, 4, 3), 2);
    setOwner(s, at(s, 4, 3), 2); // no change: not recorded
    const d = drainTileChanges(s);
    expect(d.overflow).toBe(false);
    expect(Array.from(d.tiles.subarray(0, d.count))).toEqual([at(s, 3, 3), at(s, 4, 3)]);
    expect(drainTileChanges(s).count).toBe(0);
    // Fallout running out is a change too.
    s.map.fallout[at(s, 7, 7)] = 0.05;
    updateUnits(s);
    const f = drainTileChanges(s);
    expect(Array.from(f.tiles.subarray(0, f.count))).toContain(at(s, 7, 7));
    // Full: overflow, nothing more recorded until drained.
    s.changes.count = TILE_CHANGES_CAPACITY;
    recordTileChange(s, 5);
    expect(s.changes.overflow).toBe(true);
    expect(s.changes.count).toBe(TILE_CHANGES_CAPACITY);
    const o = drainTileChanges(s);
    expect(o.overflow).toBe(true);
    expect(s.changes.overflow).toBe(false);
    expect(s.changes.count).toBe(0);
  });

  it('buildingsVersion changes when a building is added, finished, upgraded, captured or removed', () => {
    const s = makeFlatGame(40, 20, 2);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    s.players[1].gold = 1e6;
    let v = s.buildingsVersion;
    const changed = (): boolean => {
      const now = s.buildingsVersion !== v;
      v = s.buildingsVersion;
      return now;
    };
    expect(build(s, 1, 'city', at(s, 19, 5)).ok).toBe(true);
    expect(changed()).toBe(true);
    for (let k = 0; k < BUILDINGS.city.buildTime * TICKS_PER_SECOND; k++) updateBuildings(s);
    expect(changed()).toBe(true); // finished
    expect(build(s, 1, 'city', at(s, 19, 5)).ok).toBe(true); // upgrade
    expect(changed()).toBe(true);
    for (let k = 0; k < BUILDINGS.city.buildTime * TICKS_PER_SECOND; k++) updateBuildings(s);
    expect(changed()).toBe(true); // level 2
    setOwner(s, at(s, 19, 5), 2); // captured
    expect(changed()).toBe(true);
    expect([...s.buildings.values()][0].owner).toBe(2);
    setOwner(s, at(s, 19, 5), 0); // neutral: destroyed
    expect(changed()).toBe(true);
    expect(s.buildings.size).toBe(0);
    markBuildingsChanged(s);
    expect(changed()).toBe(true);
  });
});

describe('territory data kept by setOwner', () => {
  it('border sets and land weights match a full recount after random changes', () => {
    const s = makeFlatGame(50, 40, 4);
    const rng = makeRng(17).rng;
    const n = s.map.owner.length;
    // Some water and rough land.
    for (let i = 0; i < n; i++) {
      const r = rng();
      if (r < 0.08) s.map.terrain[i] = Terrain.DeepWater;
      else if (r < 0.2) s.map.terrain[i] = Terrain.Mountains;
      else if (r < 0.35) s.map.terrain[i] = Terrain.Forest;
    }
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 24, 19);
    for (let k = 0; k < 6000; k++) {
      const t = Math.floor(rng() * n);
      if (s.map.terrain[t] <= 1) continue;
      setOwner(s, t, Math.floor(rng() * 5));
    }
    const { owner, terrain, width: w } = s.map;
    for (let p = 1; p <= 4; p++) {
      const expected = new Set<number>();
      let weight = 0;
      for (let i = 0; i < n; i++) {
        if (owner[i] !== p) continue;
        weight += TERRAIN[terrain[i] as TerrainId].popPerTile / 30;
        const x = i % w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
        if (nb.some((j) => j >= 0 && j < n && owner[j] !== p && terrain[j] > 1)) expected.add(i);
      }
      const { list, len } = borderTiles(s, p);
      expect(new Set(Array.from(list.subarray(0, len)))).toEqual(expected);
      expect(len).toBe(expected.size);
      expect(landWeight(s, p)).toBeCloseTo(weight, 6);
    }
  });

  it('fronts come from the border set: the whole shared border, nothing else', () => {
    const s = makeFlatGame(30, 20, 3);
    claimRect(s, 1, 0, 0, 9, 19);
    claimRect(s, 2, 10, 0, 19, 9);
    claimRect(s, 3, 10, 10, 19, 19);
    expect(frontTiles(s, 1, 2).length).toBe(10);
    expect(frontTiles(s, 1, 3).length).toBe(10);
    expect(frontTiles(s, 1, 0).length).toBe(0);
    expect(frontTiles(s, 2, 0).length).toBe(10);
  });
});

describe('a click across water sends a boat', () => {
  /** Player 1 on the left island, neutral land on the right island, sea between. */
  function islands(): GameState {
    const s = makeFlatGame(60, 20, 2);
    for (let y = 0; y < 20; y++) for (let x = 20; x < 40; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 9, 19);
    claimRect(s, 2, 50, 0, 59, 19);
    return s;
  }

  it('land on another landmass needs a boat; land you can walk to does not', () => {
    const s = islands();
    const comps = landComponents(s.map);
    expect(comps[at(s, 5, 5)]).not.toBe(comps[at(s, 45, 5)]);
    expect(needsBoat(s, 1, at(s, 45, 5))).toBe(true); // neutral land across the sea
    expect(needsBoat(s, 1, at(s, 15, 5))).toBe(false); // neutral land next to us
    expect(needsBoat(s, 1, at(s, 55, 5))).toBe(true); // player 2 across the sea
    expect(boatLandingTile(s, at(s, 41, 5))).toBe(at(s, 40, 5)); // nearest coast of that owner
  });

  it("applyAction 'attack' across water launches a transport with the same troops", () => {
    const s = islands();
    // Our own coast: take the land up to the sea.
    claimRect(s, 1, 10, 0, 19, 19);
    const before = s.players[1].troops.infantry;
    const r = applyAction(s, 1, { type: 'attack', tile: at(s, 45, 5), troops: inf(2000) });
    expect(r.ok).toBe(true);
    expect(s.attacks.length).toBe(0);
    const boats = s.units.filter((u) => u.type === 'transport');
    expect(boats.length).toBe(1);
    expect(boats[0].troops.infantry).toBe(2000);
    expect(s.players[1].troops.infantry).toBe(before - 2000);
    // Land next to us is a normal attack on the whole border.
    expect(launchAttack(s, 2, at(s, 45, 5), inf(500)).ok).toBe(true);
  });
});

describe('enclave checks are staggered and local', () => {
  it('a pocket closed by a capture is annexed within ENCLAVE_CHECK_SECONDS', () => {
    const s = makeFlatGame(40, 30, 2);
    claimRect(s, 1, 0, 0, 39, 29);
    // Player 2: a main body at the edge (touching neutral land) and a 9-tile piece joined to it by one tile.
    for (let y = 0; y < 30; y++) for (let x = 36; x < 40; x++) setOwner(s, at(s, x, y), 0);
    claimRect(s, 2, 30, 0, 35, 29);
    claimRect(s, 2, 10, 10, 12, 12);
    claimRect(s, 2, 13, 11, 29, 11); // a corridor to the main body
    updateEndgame(s);
    expect(s.map.owner[at(s, 11, 11)]).toBe(2);
    // Player 1 cuts the corridor: the piece is now surrounded by player 1 alone.
    setOwner(s, at(s, 20, 11), 1);
    for (let k = 0; k < ENCLAVE_CHECK_SECONDS * TICKS_PER_SECOND; k++) {
      updateEndgame(s);
      s.tick++;
    }
    expect(s.map.owner[at(s, 11, 11)]).toBe(1);
    expect(s.map.owner[at(s, 30, 5)]).toBe(2); // the main body stays
  });
});
