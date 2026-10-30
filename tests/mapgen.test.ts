// Map generation: determinism, land share per map type, coherent terrain (no speckle), landmass structure,
// clustered and spread-out resources, generation time on the biggest map.
import { describe, expect, it } from 'vitest';
import { MAP_SIZES } from '../src/sim/config';
import { generateMap } from '../src/sim/mapgen';
import { makeRng } from '../src/sim/rng';
import { Resource, Terrain, isWater } from '../src/sim/types';
import type { MapData, MapSize, MapType } from '../src/sim/types';
import { testSettings } from './helpers';

function gen(mapType: MapType, mapSize: MapSize, seed: number): MapData {
  return generateMap(testSettings({ mapType, mapSize, seed, aiCount: 7 }), makeRng(seed).rng);
}

/** Share of land tiles whose terrain differs from >= 3 of their 4 neighbours (water counts as different). */
function speckle(map: MapData): number {
  const { width: w, height: h, terrain } = map;
  let bad = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      if (isWater(t)) continue;
      let d = 0;
      if (x > 0 && terrain[i - 1] !== t) d++;
      if (x < w - 1 && terrain[i + 1] !== t) d++;
      if (y > 0 && terrain[i - w] !== t) d++;
      if (y < h - 1 && terrain[i + w] !== t) d++;
      if (d >= 3) bad++;
    }
  }
  return bad / map.landTileCount;
}

/** Sizes of the 4-connected land components, largest first. */
function landmasses(map: MapData): number[] {
  const { width: w, height: h, terrain } = map;
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || isWater(terrain[s])) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || seen[j] || isWater(terrain[j])) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    sizes.push(tail);
  }
  return sizes.sort((a, b) => b - a);
}

const LAND_SHARE: Record<MapType, [number, number]> = {
  continents: [0.4, 0.5],
  pangaea: [0.55, 0.65],
  archipelago: [0.25, 0.35],
  highlands: [0.5, 0.6],
};
const TYPES = Object.keys(LAND_SHARE) as MapType[];

describe('mapgen: sizes', () => {
  it('has the grand-scale sizes, huge included', () => {
    expect(MAP_SIZES.small).toEqual({ width: 900, height: 560 });
    expect(MAP_SIZES.medium).toEqual({ width: 1400, height: 880 });
    expect(MAP_SIZES.large).toEqual({ width: 2000, height: 1250 });
    expect(MAP_SIZES.huge).toEqual({ width: 2600, height: 1600 });
  });
});

describe('mapgen: determinism', () => {
  it('same seed -> identical map, other seed -> different map', () => {
    const a = gen('continents', 'small', 5);
    const b = gen('continents', 'small', 5);
    const c = gen('continents', 'small', 6);
    expect(Buffer.from(a.terrain).equals(Buffer.from(b.terrain))).toBe(true);
    expect(Buffer.from(a.resource).equals(Buffer.from(b.resource))).toBe(true);
    expect(a.landTileCount).toBe(b.landTileCount);
    expect(Buffer.from(a.terrain).equals(Buffer.from(c.terrain))).toBe(false);
  });
  it('leaves the rng in the same state for the same seed', () => {
    const r1 = makeRng(9);
    const r2 = makeRng(9);
    generateMap(testSettings({ mapType: 'archipelago', seed: 9 }), r1.rng);
    generateMap(testSettings({ mapType: 'archipelago', seed: 9 }), r2.rng);
    expect(r1.state.s).toBe(r2.state.s);
  });
});

describe('mapgen: every map type (medium, 2 seeds)', () => {
  for (const mapType of TYPES) {
    for (const seed of [11, 12]) {
      it(`${mapType} seed ${seed}`, () => {
        const map = gen(mapType, 'medium', seed);
        const { width: w, height: h, terrain, resource, coastal } = map;
        const n = w * h;
        expect([w, h]).toEqual([1400, 880]);

        // land share and counters
        let land = 0;
        let coastErr = 0;
        let resErr = 0;
        const tcount = new Array(9).fill(0);
        const rcount = [0, 0, 0, 0];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const t = terrain[i];
            tcount[t]++;
            if (!isWater(t)) land++;
            const touches =
              (x > 0 && isWater(terrain[i - 1])) || (x < w - 1 && isWater(terrain[i + 1])) || (y > 0 && isWater(terrain[i - w])) || (y < h - 1 && isWater(terrain[i + w]));
            if (coastal[i] !== (!isWater(t) && touches ? 1 : 0)) coastErr++;
            // coastal land only ever touches shallow water
            if (!isWater(t) && touches) {
              for (const j of [i - 1, i + 1, i - w, i + w]) if (isWater(terrain[j]) && terrain[j] !== Terrain.ShallowWater) coastErr++;
            }
            const r = resource[i];
            rcount[r]++;
            if (r === Resource.Iron && t !== Terrain.Hills && t !== Terrain.Mountains) resErr++;
            if (r === Resource.Oil && t !== Terrain.Desert && t !== Terrain.Swamp && t !== Terrain.Tundra) resErr++;
            if (r === Resource.Fertile && t !== Terrain.Plains) resErr++;
          }
        }
        expect(map.landTileCount).toBe(land);
        expect(coastErr).toBe(0);
        expect(resErr).toBe(0);
        const share = land / n;
        expect(share).toBeGreaterThanOrEqual(LAND_SHARE[mapType][0]);
        expect(share).toBeLessThanOrEqual(LAND_SHARE[mapType][1]);
        // map border is water
        for (let x = 0; x < w; x++) expect(isWater(terrain[x]) && isWater(terrain[n - 1 - x])).toBe(true);
        for (let y = 0; y < h; y++) expect(isWater(terrain[y * w]) && isWater(terrain[y * w + w - 1])).toBe(true);

        // every biome shows up; highlands are rugged
        for (const t of [Terrain.Plains, Terrain.Forest, Terrain.Hills, Terrain.Mountains, Terrain.Desert, Terrain.Swamp, Terrain.Tundra]) {
          expect(tcount[t] / land).toBeGreaterThan(0.01);
        }
        const rugged = (tcount[Terrain.Hills] + tcount[Terrain.Mountains]) / land;
        if (mapType === 'highlands') expect(rugged).toBeGreaterThan(0.35);
        else expect(rugged).toBeLessThan(0.25);

        // large coherent regions: almost no salt-and-pepper tiles
        expect(speckle(map)).toBeLessThan(0.02);

        // landmass structure
        const masses = landmasses(map);
        const big = masses.filter((s) => s >= land * 0.03).length;
        if (mapType === 'pangaea') expect(masses[0] / land).toBeGreaterThan(0.9);
        if (mapType === 'continents') {
          expect(big).toBeGreaterThanOrEqual(3);
          expect(big).toBeLessThanOrEqual(7);
        }
        if (mapType === 'archipelago') {
          expect(masses.length).toBeGreaterThanOrEqual(10);
          expect(masses[0] / land).toBeLessThan(0.5);
        }

        // resources: about the configured shares, in clusters, spread over the map
        expect(rcount[Resource.Iron]).toBeGreaterThan(land * 0.01);
        expect(rcount[Resource.Oil]).toBeGreaterThan(land * 0.005);
        expect(rcount[Resource.Fertile]).toBeGreaterThan(land * 0.01);
        let res = 0;
        let clustered = 0;
        for (let i = 0; i < n; i++) {
          const r = resource[i];
          if (!r) continue;
          res++;
          const x = i % w;
          if ((x > 0 && resource[i - 1] === r) || (x < w - 1 && resource[i + 1] === r) || resource[i - w] === r || resource[i + w] === r) clustered++;
        }
        expect(clustered / res).toBeGreaterThan(0.9);
        // 6 x 4 regions: every region with a fair share of land has some resource
        let regions = 0;
        let withRes = 0;
        for (let ry = 0; ry < 4; ry++) {
          for (let rx = 0; rx < 6; rx++) {
            let l = 0;
            let r = 0;
            for (let y = Math.floor((ry * h) / 4); y < Math.floor(((ry + 1) * h) / 4); y++) {
              for (let x = Math.floor((rx * w) / 6); x < Math.floor(((rx + 1) * w) / 6); x++) {
                const i = y * w + x;
                if (isWater(terrain[i])) continue;
                l++;
                if (resource[i]) r++;
              }
            }
            if (l < land * 0.02) continue;
            regions++;
            if (r > 0) withRes++;
          }
        }
        expect(withRes).toBe(regions);
      });
    }
  }
});

describe('mapgen: speed', () => {
  it('generates a huge map in under 4 s', () => {
    const t0 = performance.now();
    const map = gen('continents', 'huge', 3);
    const ms = performance.now() - t0;
    expect(map.width * map.height).toBe(2600 * 1600);
    expect(speckle(map)).toBeLessThan(0.02);
    expect(ms).toBeLessThan(4000);
  });
});
