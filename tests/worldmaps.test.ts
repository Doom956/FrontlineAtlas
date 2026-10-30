// Real-world maps (src/sim/worldmaps.ts): every map loads, matches its manifest entry, has valid spawns, and loads
// identically every time.
import { isWater } from '../src/sim/types';
import { getWorldMap, isWorldMapId, listWorldMaps, loadWorldMap, worldMapSpawns } from '../src/sim/worldmaps';

function hashArrays(...arrs: ArrayLike<number>[]): number {
  let h = 0x811c9dc5;
  for (const a of arrs)
    for (let i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 0x01000193);
    }
  return h >>> 0;
}

describe('world maps', () => {
  const maps = listWorldMaps();

  it('has about a dozen maps with unique ids and sane sizes', () => {
    expect(maps.length).toBeGreaterThanOrEqual(10);
    expect(new Set(maps.map((m) => m.id)).size).toBe(maps.length);
    expect(maps.some((m) => m.id === 'world')).toBe(true);
    for (const m of maps) {
      expect(m.width).toBeLessThanOrEqual(2600);
      expect(m.height).toBeLessThanOrEqual(1600);
      expect(m.landTiles).toBeGreaterThanOrEqual(500_000);
      expect(m.landTiles).toBeLessThanOrEqual(2_000_000);
      expect(m.spawns.length).toBeGreaterThanOrEqual(18);
      expect(m.spawns.length).toBeLessThanOrEqual(40);
      expect(m.recommendedNations).toBeGreaterThan(0);
      expect(m.recommendedNations).toBeLessThanOrEqual(m.spawns.length);
      expect(m.recommendedTribes).toBeGreaterThanOrEqual(0);
      // presets: single player = few nations + many tribes, multiplayer = about ten nations
      expect(m.presets.singlePlayer.nations).toBe(m.recommendedNations);
      expect(m.presets.singlePlayer.tribes).toBe(m.recommendedTribes);
      expect(m.presets.singlePlayer.nations).toBeLessThanOrEqual(8);
      expect(m.presets.singlePlayer.tribes).toBeGreaterThan(m.presets.multiplayer.tribes);
      expect(m.presets.multiplayer.nations).toBe(10);
      for (const p of [m.presets.singlePlayer, m.presets.multiplayer]) expect(p.tribes).toBeLessThanOrEqual(500);
      expect(isWorldMapId(m.id)).toBe(true);
      expect(getWorldMap(m.id)?.name).toBe(m.name);
    }
    expect(isWorldMapId('generated')).toBe(false);
    expect(worldMapSpawns('nope')).toEqual([]);
  });

  for (const info of listWorldMaps()) {
    it(`${info.id}: loads, matches the manifest, spawns on unique land tiles`, async () => {
      const map = await loadWorldMap(info.id);
      expect(map.width).toBe(info.width);
      expect(map.height).toBe(info.height);
      const n = map.width * map.height;
      expect(map.terrain.length).toBe(n);
      expect(map.landTileCount).toBe(info.landTiles);
      let land = 0;
      let res = 0;
      let bad = 0;
      for (let i = 0; i < n; i++) {
        const t = map.terrain[i];
        if (t > 8) bad++;
        if (!isWater(t)) land++;
        const r = map.resource[i];
        if (r !== 0) {
          res++;
          if (isWater(t) || r > 3) bad++; // resources only on land, ids 1..3
        }
        if (map.owner[i] !== 0 || map.building[i] !== 0) bad++; // a fresh map is empty
      }
      expect(bad).toBe(0);
      expect(land).toBe(info.landTiles);
      expect(res).toBeGreaterThan(land * 0.02);
      // coastal flags were computed (some land touches water)
      let coast = 0;
      for (let i = 0; i < n; i++) coast += map.coastal[i];
      expect(coast).toBeGreaterThan(0);

      const spawns = worldMapSpawns(info.id);
      expect(spawns.length).toBe(info.spawns.length);
      const tiles = new Set<number>();
      const names = new Set<string>();
      for (const s of spawns) {
        expect(Number.isInteger(s.tile)).toBe(true);
        expect(s.tile).toBeGreaterThanOrEqual(0);
        expect(s.tile).toBeLessThan(n);
        expect(isWater(map.terrain[s.tile])).toBe(false);
        tiles.add(s.tile);
        names.add(s.name);
      }
      expect(tiles.size).toBe(spawns.length);
      expect(names.size).toBe(spawns.length);

      // capitals: never on mountains, and far enough apart for the game's largest spawn distance (26 tiles)
      const W = map.width;
      const xy = spawns.map((s) => [s.tile % W, Math.floor(s.tile / W)]);
      let minD = Infinity;
      for (let a = 0; a < xy.length; a++) {
        expect(map.terrain[spawns[a].tile]).not.toBe(5);
        for (let b = a + 1; b < xy.length; b++) minD = Math.min(minD, Math.hypot(xy[a][0] - xy[b][0], xy[a][1] - xy[b][1]));
      }
      expect(minD).toBeGreaterThanOrEqual(26);
      // spread-out order: the first ten are farther apart than ten spawns taken from the end of the list
      const closest = (pts: number[][]): number => {
        let d = Infinity;
        for (let a = 0; a < pts.length; a++)
          for (let b = a + 1; b < pts.length; b++) d = Math.min(d, Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]));
        return d;
      };
      expect(closest(xy.slice(0, 10))).toBeGreaterThan(closest(xy.slice(-10)));
      expect(closest(xy.slice(0, 10))).toBeGreaterThan(Math.sqrt(W * map.height) / 10);
    });
  }

  it('is deterministic: two loads give identical, independent maps', async () => {
    const a = await loadWorldMap('europe');
    const b = await loadWorldMap('europe');
    expect(a.terrain === b.terrain).toBe(false);
    expect(hashArrays(a.terrain, a.resource, a.coastal)).toBe(hashArrays(b.terrain, b.resource, b.coastal));
    a.owner[0] = 5; // mutating one game's map must not leak into the next load
    const c = await loadWorldMap('europe');
    expect(c.owner[0]).toBe(0);
  });

  it('rejects unknown ids', async () => {
    await expect(loadWorldMap('atlantis')).rejects.toThrow();
  });
});
