// Map renderer data paths that run without a browser: the tile feed (change list -> mirror, flashes, dirty
// blocks), deposit clusters, marker data and zoom tiers.
import { describe, expect, it } from 'vitest';
import { createTileChanges, recordTileChange } from '../src/sim/changes';
import type { GameState } from '../src/sim/types';
import { markerSize } from '../src/client/render/buildings';
import { buildDeposits, buildTerrain } from '../src/client/render/terrain';
import { BLOCK, dirtyRects, FALLOUT_BIT, FLASH_LOST, FLASH_MINE, FLASH_MS, FLASH_OTHER, KIND_SHIFT, OWNER_MASK, TileFeed } from '../src/client/render/tiles';
import { MARKER_DATA, MARKER_IDS } from '../src/client/icons';
import { tick } from '../src/sim/sim';
import { makeTestGame } from './helpers';

function fakeState(w: number, h: number, humanId = 1): GameState {
  const n = w * h;
  return {
    humanId,
    map: {
      width: w,
      height: h,
      terrain: new Uint8Array(n).fill(2),
      resource: new Uint8Array(n),
      owner: new Uint16Array(n),
      building: new Int32Array(n),
      coastal: new Uint8Array(n),
      fallout: new Float32Array(n),
      landTileCount: n,
    },
    changes: createTileChanges(),
  } as unknown as GameState;
}

function setOwner(s: GameState, i: number, o: number): void {
  s.map.owner[i] = o;
  recordTileChange(s, i);
}

describe('TileFeed', () => {
  it('mirrors owners from the change feed and tells listeners old and new owner', () => {
    const s = fakeState(200, 150);
    s.map.owner[5] = 3;
    const feed = new TileFeed();
    feed.reset(s);
    expect(feed.owner(5)).toBe(3);
    feed.clearDirty();
    const heard: number[][] = [];
    feed.listeners.push((t, a, b) => heard.push([t, a, b]));
    setOwner(s, 5, 1); // you take it from 3
    setOwner(s, 10, 2); // 2 expands into neutral land: no flash
    setOwner(s, 199 * 1 + 140 * 200, 1); // you take neutral land
    s.map.fallout[20] = 30;
    recordTileChange(s, 20);
    feed.update(1000, 1);
    expect(heard).toEqual([
      [5, 3, 1],
      [10, 0, 2],
      [199 + 140 * 200, 0, 1],
    ]);
    expect(feed.owner(5)).toBe(1);
    expect((feed.mirror[5] >>> KIND_SHIFT) & 7).toBe(FLASH_MINE);
    expect((feed.mirror[10] >>> KIND_SHIFT) & 7).toBe(0);
    expect(feed.mirror[20] & FALLOUT_BIT).toBe(FALLOUT_BIT);
    expect(feed.mirror[5] >>> 16).toBe(10); // 1000 ms = 10 deciseconds
    // two dirty blocks: (0,0) and the one holding tile (199, 140)
    expect(feed.dirtyList.length).toBe(2);
    feed.clearDirty();

    setOwner(s, 5, 4); // 4 takes it from you
    setOwner(s, 11, 3);
    setOwner(s, 10, 3); // 3 takes it from 2: a fight between others
    feed.update(1100, 1);
    expect((feed.mirror[5] >>> KIND_SHIFT) & 7).toBe(FLASH_LOST);
    expect((feed.mirror[10] >>> KIND_SHIFT) & 7).toBe(FLASH_OTHER);
    // flashes end after FLASH_MS
    feed.clearDirty();
    feed.update(1100 + FLASH_MS + 200, 1);
    expect(feed.mirror[5] >>> KIND_SHIFT).toBe(0);
    expect(feed.mirror[5] & OWNER_MASK).toBe(4);
    expect(feed.mirror[199 + 140 * 200] >>> KIND_SHIFT).toBe(0);
    expect(feed.dirtyList.length).toBe(2);
  });

  it('spreads a big batch over the frames until the next tick and drops duplicates', () => {
    const s = fakeState(300, 300);
    const feed = new TileFeed();
    feed.reset(s);
    for (let i = 0; i < 3000; i++) setOwner(s, i, 2);
    for (let i = 0; i < 500; i++) recordTileChange(s, i); // duplicates
    feed.update(0, 3);
    const first = feed.applied;
    expect(first).toBeGreaterThan(900);
    expect(first).toBeLessThan(1100);
    feed.update(16, 3);
    feed.update(32, 3);
    let total = first + 0;
    for (let i = 0; i < 3000; i++) if (feed.owner(i) === 2) total++;
    expect(total - first).toBe(3000);
  });

  it('rebuilds everything when the sim reports an overflow', () => {
    const s = fakeState(64, 64);
    const feed = new TileFeed();
    feed.reset(s);
    const gen = feed.fullGen;
    s.map.owner[7] = 9;
    s.changes.overflow = true;
    feed.update(0, 1);
    expect(feed.fullGen).toBe(gen + 1);
    expect(feed.owner(7)).toBe(9);
    expect(feed.dirtyList.length).toBe(1);
  });

  it('stays equal to a real game when several ticks run between frames', () => {
    const s = makeTestGame({ aiCount: 6, tribeCount: 10, humanPlayer: false });
    const feed = new TileFeed();
    feed.reset(s);
    let changed = 0;
    for (let frame = 0; frame < 120; frame++) {
      for (let k = 0; k < 1 + (frame % 4); k++) tick(s); // 1-4 ticks per frame, like x4 speed
      changed += s.changes.count;
      feed.update(frame * 16, 2);
      feed.clearDirty();
    }
    for (let k = 0; k < 10; k++) feed.update(5000 + k * 16, 1); // let the drip queue empty
    expect(changed).toBeGreaterThan(100);
    const { owner, fallout } = s.map;
    let bad = 0;
    for (let i = 0; i < owner.length; i++) {
      if (feed.owner(i) !== (owner[i] & OWNER_MASK) || (feed.mirror[i] & FALLOUT_BIT ? 1 : 0) !== (fallout[i] > 0 ? 1 : 0)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('merges dirty blocks of a row into upload rectangles', () => {
    const s = fakeState(BLOCK * 10, BLOCK * 3);
    const feed = new TileFeed();
    feed.reset(s);
    feed.clearDirty();
    const w = s.map.width;
    // row 0: blocks 1, 2, 4 (gap of one) and 8; row 2: block 0
    for (const bx of [1, 2, 4, 8]) setOwner(s, bx * BLOCK + 3, 2);
    setOwner(s, 2 * BLOCK * w + 5, 2);
    feed.update(0, 1);
    expect(dirtyRects(feed, 1)).toEqual([
      [BLOCK, 0, BLOCK * 4, BLOCK],
      [BLOCK * 8, 0, BLOCK, BLOCK],
      [0, BLOCK * 2, BLOCK, BLOCK],
    ]);
    expect(dirtyRects(feed, 0).length).toBe(4);
  });
});

describe('terrain data', () => {
  it('gives water a distance to land and clusters deposits', () => {
    const s = fakeState(40, 20);
    const { terrain, resource } = s.map;
    for (let y = 0; y < 20; y++) for (let x = 20; x < 40; x++) terrain[y * 40 + x] = 0;
    const t = buildTerrain(s.map);
    expect(t.depth[5 * 40 + 19]).toBe(0);
    expect(t.depth[5 * 40 + 20]).toBe(1);
    expect(t.depth[5 * 40 + 25]).toBe(6);
    // two iron clusters (one diagonal-connected), one oil tile
    for (const i of [41, 42, 83, 300]) resource[i] = 1;
    resource[600] = 2;
    const d = buildDeposits(s.map, 12);
    expect(d.near.map((c) => [c.res, c.tiles]).sort()).toEqual([
      [1, 1],
      [1, 3],
      [2, 1],
    ]);
    const big = d.near.find((c) => c.tiles === 3)!;
    expect([41, 42, 83]).toContain(big.tile);
    expect(d.far.reduce((a, c) => a + c.tiles, 0)).toBe(5);
  });
});

describe('map markers', () => {
  it('has a simplified glyph for every building and deposit', () => {
    expect(MARKER_IDS.length).toBe(20);
    for (const id of MARKER_IDS) {
      const layers = MARKER_DATA[id];
      expect(layers.length, id).toBeGreaterThan(0);
      expect(layers.some((l) => !l.detail && (l.mode ?? 'fill') !== 'cut'), id).toBe(true);
      for (const l of layers) expect(l.d, id).toMatch(/^M[-\d.]/);
    }
  });

  it('grows markers with zoom within limits', () => {
    expect(markerSize(1)).toBe(16); // the floor: readable at normal play zoom
    expect(markerSize(8)).toBeGreaterThan(markerSize(4));
    expect(markerSize(40)).toBe(40);
  });
});
