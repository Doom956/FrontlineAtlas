// Supply lines (art/detailed/supplyLines.ts, pure): rails between a nation's hubs over its own dry land, round
// mountains and swamps, over rivers on short bridges only; rail yards where 3 rails meet; sea lanes over open water.
// The same result every time and for any input order.
import { describe, expect, it } from 'vitest';
import { BRIDGE_MAX, junctions, pathLength, pointAt, railNetwork, railRoute, seaLane, type Hub, type SupplyTerrain } from '../src/client/art/detailed/supplyLines';

const W = 80;
const H = 60;
/** A grid map from a painter: (x, y) => terrain id; owner 1 on all land unless `owner` says otherwise. */
function world(paint: (x: number, y: number) => number, owner?: (x: number, y: number) => number): SupplyTerrain {
  const t = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) t[y * W + x] = paint(x, y);
  const ter = (x: number, y: number): number => (x < 0 || y < 0 || x >= W || y >= H ? 0 : t[y * W + x]);
  return { terrain: ter, owner: (x, y) => (ter(x, y) <= 1 ? 0 : owner ? owner(x, y) : 1) };
}
let n = 0;
const hub = (x: number, y: number, type: Hub['type'] = 'city', owner = 1): Hub => ({ id: ++n, type, x, y, owner });

/** Every point of the path, sampled every 0.1 tile, outside the bridges, lies on owner's dry, passable land. */
function onOwnLand(path: [number, number][], bridges: [number, number][], t: SupplyTerrain, owner: number): boolean {
  const L = pathLength(path);
  for (let s = 0; s <= L; s += 0.1) {
    if (bridges.some(([a, b]) => s >= a - 0.4 && s <= b + 0.4)) continue;
    const p = pointAt(path, s);
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const tt = t.terrain(x, y);
    if (tt <= 1 || tt === 5 || tt === 7 || t.owner(x, y) !== owner) return false;
  }
  return true;
}

describe('rail routes', () => {
  it('goes round a mountain block and a swamp, staying on own dry land', () => {
    const t = world((x, y) => (x >= 30 && x <= 40 && y >= 12 && y <= 40 ? 5 : x >= 44 && x <= 50 && y >= 24 && y <= 46 ? 7 : 2));
    const a = hub(10, 30);
    const b = hub(68, 30);
    const r = railRoute(a, b, t);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(onOwnLand(r.path, r.bridges, t, 1)).toBe(true);
    expect(r.bridges).toEqual([]);
    // it starts and ends on the two hubs' tile centres
    expect(r.path[0]).toEqual([10.5, 30.5]);
    expect(r.path[r.path.length - 1]).toEqual([68.5, 30.5]);
  });

  it('crosses a narrow river on one short straight bridge, never a wide one', () => {
    const narrow = world((x) => (x >= 38 && x <= 39 ? 1 : 2));
    const r = railRoute(hub(20, 30), hub(60, 30), narrow);
    expect(r).not.toBeNull();
    expect(r?.bridges.length).toBe(1);
    const [s0, s1] = r?.bridges[0] ?? [0, 0];
    expect(s1 - s0).toBeLessThanOrEqual(BRIDGE_MAX);
    const wide = world((x) => (x >= 36 && x <= 41 ? 1 : 2));
    expect(railRoute(hub(20, 30), hub(60, 30), wide)).toBeNull();
  });

  it('never crosses another nation\'s land', () => {
    const t = world(() => 2, (x, y) => (x >= 35 && x <= 40 && y >= 0 ? 2 : 1));
    expect(railRoute(hub(20, 30), hub(60, 30), t)).toBeNull();
    const gap = world(() => 2, (x, y) => (x >= 35 && x <= 40 && y < 40 ? 2 : 1));
    const r = railRoute(hub(20, 30), hub(60, 30), gap);
    expect(r).not.toBeNull();
    if (r) expect(onOwnLand(r.path, r.bridges, gap, 1)).toBe(true);
  });

  it('is the same every time and for any hub order', () => {
    const t = world((x, y) => ((x * 7 + y * 13) % 23 === 0 ? 5 : (x * 3 + y) % 17 === 0 ? 4 : 2));
    const hs = [hub(10, 10), hub(30, 14), hub(22, 34), hub(50, 30), hub(64, 12, 'factory'), hub(40, 50, 'fort')];
    const one = railNetwork(hs, t);
    const two = railNetwork(hs.slice().reverse(), t);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(JSON.stringify(railNetwork(hs, t))).toBe(JSON.stringify(one));
    expect(one.length).toBeGreaterThan(0);
    for (const r of one) expect(onOwnLand(r.path, r.bridges, t, 1)).toBe(true);
  });
});

describe('rail network and yards', () => {
  it('links each hub to its nearest hubs of the same owner only', () => {
    const t = world(() => 2, (x) => (x < 40 ? 1 : 2));
    const hs = [hub(10, 30), hub(20, 20), hub(25, 40), hub(60, 30, 'city', 2), hub(70, 20, 'factory', 2)];
    const rails = railNetwork(hs, t);
    const byId = new Map(hs.map((h) => [h.id, h]));
    for (const r of rails) expect(byId.get(r.a)?.owner).toBe(byId.get(r.b)?.owner);
    expect(rails.some((r) => byId.get(r.a)?.owner === 2)).toBe(true);
  });

  it('puts a yard where three or more rails meet', () => {
    const t = world(() => 2);
    const c = hub(40, 30, 'factory');
    const hs = [c, hub(25, 30), hub(55, 30), hub(40, 14), hub(40, 46)];
    const rails = railNetwork(hs, t);
    const js = junctions(hs, rails);
    expect(js.map((j) => j.hub)).toContain(c.id);
    expect(js.find((j) => j.hub === c.id)?.degree).toBeGreaterThanOrEqual(3);
  });
});

describe('sea lanes', () => {
  it('runs over water only from shore to shore', () => {
    const t = world((x, y) => (x < 20 || x > 60 || (y > 26 && y < 34 && x > 34 && x < 46) ? 2 : 0));
    const lane = seaLane({ x: 19, y: 30 }, { x: 61, y: 30 }, t);
    expect(lane).not.toBeNull();
    if (!lane) return;
    const L = pathLength(lane);
    for (let s = 0.8; s < L - 0.8; s += 0.1) {
      const p = pointAt(lane, s);
      expect(t.terrain(Math.floor(p.x), Math.floor(p.y))).toBeLessThanOrEqual(1);
    }
  });
});
