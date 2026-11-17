// Dirt tracks between a nation's buildings and its nearest city (art/detailed/buildingLinks.ts pairTracks and trackPath,
// pure; render/linkLayer.ts shows them at the close look only): non-city to nearest city, a winding route that stays on
// the owner's dry land, the same every time, and no track without a city in reach.
import { describe, expect, it } from 'vitest';
import { CLOSE_ZOOM } from '../src/client/render/buildingArt';
import { LinkSet, linkInput, linkKey, trackAlpha, tracksShown, type LinkEnd } from '../src/client/render/linkLayer';
import { LINK_MAX_DIST, pairLinks, pairTracks, trackPath, type LinkBuilding, type LinkTerrain, type LinkType } from '../src/client/art/detailed/buildingLinks';
import type { Building, GameState } from '../src/sim/types';

const land = (over: Partial<LinkTerrain> = {}): LinkTerrain => ({ water: () => false, owner: () => 1, ...over });
let n = 100;
const b = (type: LinkType, x: number, y: number, owner = 1): LinkBuilding => ({ id: ++n, type, x, y, owner, level: 2 });

/** Every point of a path is dry land of `owner`. */
const onOwnLand = (path: [number, number][], t: LinkTerrain, owner: number): boolean => path.every(([x, y]) => !t.water(Math.floor(x), Math.floor(y)) && t.owner(Math.floor(x), Math.floor(y)) === owner);

/** Largest distance of a path point from the straight line between its ends, in tiles. */
function swing(path: [number, number][]): number {
  const [ax, ay] = path[0];
  const [bx, by] = path[path.length - 1];
  const len = Math.hypot(bx - ax, by - ay);
  let m = 0;
  for (const [x, y] of path) m = Math.max(m, Math.abs(((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / len));
  return m;
}

describe('dirt tracks', () => {
  it('runs every non-city building to the nearest city of its owner', () => {
    const c1 = b('city', 20, 20);
    const c2 = b('city', 36, 20);
    const farm = b('farm', 24, 23);
    const mine = b('mine', 33, 16);
    const fort = b('fort', 20, 30);
    const tracks = pairTracks([c1, c2, farm, mine, fort], land());
    const to = new Map(tracks.map((l) => [l.a, l.b]));
    expect(tracks.every((l) => l.kind === 'track')).toBe(true);
    expect(to.get(farm.id)).toBe(c1.id);
    expect(to.get(mine.id)).toBe(c2.id);
    expect(to.get(fort.id)).toBe(c1.id);
    // cities take no track of their own (city to city is the road)
    expect(to.has(c1.id) || to.has(c2.id)).toBe(false);
    expect(tracks).toHaveLength(3);
  });

  it('makes no track without a city of the same owner in reach', () => {
    expect(pairTracks([b('farm', 0, 0), b('mine', 5, 0)], land())).toEqual([]);
    expect(pairTracks([b('city', 0, 0), b('farm', LINK_MAX_DIST.track + 1, 0)], land())).toEqual([]);
    // an enemy city next door is not a destination
    const t = land({ owner: (x) => (x < 4 ? 1 : 2) });
    expect(pairTracks([b('farm', 1, 0, 1), b('city', 6, 0, 2)], t)).toEqual([]);
    // nobody's buildings are left alone
    expect(pairTracks([b('city', 0, 0, 0), b('farm', 4, 0, 0)], land({ owner: () => 0 }))).toEqual([]);
  });

  it('keeps quay, trench and road as they were', () => {
    const blds = [b('city', 0, 0), b('farm', 5, 3), b('fort', 9, 0), b('fort', 15, 0)];
    expect(pairLinks(blds, land()).map((l) => l.kind)).toEqual(['trench']);
  });

  it('winds: a gentle meander, smooth, pinned on the two buildings', () => {
    const a = b('farm', 10, 10);
    const c = b('city', 26, 14);
    const path = trackPath(a, c, land());
    expect(path).not.toBeNull();
    const p = path!;
    expect(p[0]).toEqual([10.5, 10.5]);
    expect(p[p.length - 1][0]).toBeCloseTo(26.5, 9);
    expect(p[p.length - 1][1]).toBeCloseTo(14.5, 9);
    // not straight, but never far off the line
    expect(swing(p)).toBeGreaterThan(0.3);
    expect(swing(p)).toBeLessThan(2);
    // smooth: no sharp turn between neighbouring steps
    for (let i = 1; i + 1 < p.length; i++) {
      const t1 = Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0]);
      const t2 = Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]);
      let d = Math.abs(t2 - t1);
      if (d > Math.PI) d = Math.PI * 2 - d;
      expect(d).toBeLessThan(0.6);
    }
  });

  it('is deterministic: the same route every time and for any input order', () => {
    const blds = [b('city', 10, 10), b('farm', 2, 4), b('lab', 18, 15), b('airfield', 6, 22), b('city', 30, 10), b('factory', 24, 4)];
    const one = pairTracks(blds, land());
    const two = pairTracks(blds.slice().reverse(), land());
    expect(two).toEqual(one);
    expect(pairTracks(blds, land())).toEqual(one);
    // different pairs bend differently
    const s = one.map((l) => JSON.stringify(l.path!.slice(1, -1).map(([x, y]) => [x - l.path![0][0], y - l.path![0][1]])));
    expect(new Set(s).size).toBe(s.length);
  });

  it('stays on its own dry land: bends away from water and enemy land, or goes straighter, or skips', () => {
    const farm = b('farm', 10, 10);
    const city = b('city', 26, 10);
    // the free route's swing and side, then water and an enemy strip hugging that side of the line
    const free = trackPath(farm, city, land())!;
    const mid = free[free.length >> 1];
    const side = Math.sign(mid[1] - 10.5) || 1;
    const lake = land({ water: (x, y) => x >= 14 && x <= 22 && (side > 0 ? y >= 11 : y <= 9) });
    const wet = trackPath(farm, city, lake);
    expect(wet).not.toBeNull();
    expect(onOwnLand(wet!, lake, 1)).toBe(true);
    const enemy = land({ owner: (x, y) => (x >= 14 && x <= 22 && (side > 0 ? y >= 11 : y <= 9) ? 2 : 1) });
    expect(onOwnLand(trackPath(farm, city, enemy)!, enemy, 1)).toBe(true);
    // a narrow causeway one tile wide: only a much straighter track fits, inside it
    const causeway = land({ water: (_x, y) => y !== 10 });
    const straight = trackPath(farm, city, causeway);
    expect(straight).not.toBeNull();
    expect(straight!.every(([, y]) => Math.floor(y) === 10)).toBe(true);
    expect(swing(straight!)).toBeLessThan(swing(free));
    // cut off by water: no track at all
    const cut = land({ water: (x) => x === 18 });
    expect(trackPath(farm, city, cut)).toBeNull();
    expect(pairTracks([farm, city], cut)).toEqual([]);
  });

  it('takes the next nearest city when the nearest one cannot be reached', () => {
    const farm = b('farm', 10, 10);
    const near = b('city', 16, 10);
    const far = b('city', 10, 20);
    const t = land({ water: (x, y) => x === 13 && y < 13 });
    const tracks = pairTracks([farm, near, far], t);
    expect(tracks.map((l) => [l.a, l.b])).toEqual([[farm.id, far.id]]);
    expect(onOwnLand(tracks[0].path!, t, 1)).toBe(true);
  });

  it('shows at the close look only, fading in', () => {
    expect(tracksShown(CLOSE_ZOOM - 0.01)).toBe(false);
    expect(trackAlpha(10)).toBe(0);
    expect(trackAlpha(CLOSE_ZOOM)).toBeGreaterThan(0);
    expect(trackAlpha(CLOSE_ZOOM)).toBeLessThan(1);
    expect(trackAlpha(CLOSE_ZOOM + 0.4)).toBeGreaterThan(trackAlpha(CLOSE_ZOOM));
    expect(trackAlpha(14)).toBe(1);
    expect(trackAlpha(20)).toBe(1);
  });

  it('comes from the game buildings through the cached link set, rebuilt only when the set changes', () => {
    const W = 60;
    const H = 40;
    const owner = new Uint16Array(W * H).fill(1);
    const at = (x: number, y: number): number => y * W + x;
    const buildings = new Map<number, Building>();
    const put = (id: number, type: Building['type'], x: number, y: number, extra: Partial<Building> = {}): void => {
      buildings.set(id, { id, type, owner: 1, tile: at(x, y), level: 1, buildLeft: 0, ...extra } as Building);
    };
    put(1, 'city', 20, 20);
    put(2, 'farm', 26, 22);
    put(3, 'barracks', 15, 14);
    put(4, 'mine', 30, 30, { buildLeft: 4 });
    const state = { tick: 0, buildings, map: { width: W, height: H, terrain: new Uint8Array(W * H).fill(3), owner } } as unknown as GameState;
    const endOf = (bd: Building): LinkEnd => ({ tile: bd.tile, type: bd.type, level: bd.level, facing: 0, sig: `${bd.type}${bd.level}` });
    const set = new LinkSet();
    const frame = (v: number): boolean => set.update(linkKey(v, -1, state.tick, W), () => linkInput(state, [...buildings.values()], endOf));
    expect(frame(1)).toBe(true);
    const tracks = set.links.filter((l) => l.link.kind === 'track');
    // the unfinished mine takes no track yet
    expect(tracks.map((l) => [l.link.a, l.link.b]).sort()).toEqual([[at(15, 14), at(20, 20)], [at(26, 22), at(20, 20)]].sort());
    expect(frame(1)).toBe(false);
    expect(set.computed).toBe(1);
    buildings.get(4)!.buildLeft = 0;
    expect(frame(2)).toBe(true);
    expect(set.links.filter((l) => l.link.kind === 'track')).toHaveLength(3);
  });
});
