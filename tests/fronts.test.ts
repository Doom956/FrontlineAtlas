// Front lines (render/fronts.ts): border edge runs, push arrow spots, measured speed, and the warring pairs' edge
// sets kept from the tile feed (they must match a full rescan of the drawn mirror after any changes).
import { describe, expect, it } from 'vitest';
import { createTileChanges, recordTileChange } from '../src/sim/changes';
import type { Attack, GameState } from '../src/sim/types';
import { chainSegments, chunkLines, edgeId, farStep, FrontLayer, frontSpots, measuredSpeed, mergeSegments, pairKey, seedEdges, simplifyLine, WAR_MEMORY_TICKS } from '../src/client/render/fronts';
import { OWNER_MASK, TileFeed } from '../src/client/render/tiles';
import { Camera } from '../src/client/camera';
import type { UiState } from '../src/client/uiState';
import { makeRng } from '../src/sim/rng';
import { onOwnerChange } from '../src/sim/territory';

function fakeState(w: number, h: number, players = 3): GameState {
  const n = w * h;
  return {
    tick: 0,
    humanId: 1,
    attacks: [] as Attack[],
    players: Array.from({ length: players + 1 }, (_, id) => ({ id, name: `P${id}`, alive: id > 0, personality: null, color: [100, 100, 100] })),
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

function attack(id: number, attacker: number, target: number): Attack {
  return { id, attacker, target, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: -1, progress: 0, startTick: 0, amphibious: false, losses: 0, tilesTaken: 0 };
}

/** Every edge between a and b in an owner array, the slow way. */
function scan(owner: (i: number) => number, w: number, h: number, a: number, b: number): Set<number> {
  const out = new Set<number>();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = owner(i);
      if (x < w - 1) {
        const r = owner(i + 1);
        if ((o === a && r === b) || (o === b && r === a)) out.add(edgeId(i, 0));
      }
      if (y < h - 1) {
        const d = owner(i + w);
        if ((o === a && d === b) || (o === b && d === a)) out.add(edgeId(i, 1));
      }
    }
  return out;
}

describe('mergeSegments', () => {
  it('merges a straight border into one run', () => {
    const w = 10;
    // edges between column 3 and 4 on rows 0..5: one vertical line at x = 4 from y 0 to 6
    const edges = [0, 1, 2, 3, 4, 5].map((y) => edgeId(y * w + 3, 0));
    expect(mergeSegments(edges, w)).toEqual([4, 0, 4, 6]);
  });
  it('keeps gaps and both orientations apart', () => {
    const w = 10;
    const edges = [edgeId(0 * w + 3, 0), edgeId(1 * w + 3, 0), edgeId(3 * w + 3, 0), edgeId(2 * w + 5, 1), edgeId(2 * w + 6, 1)];
    expect(mergeSegments(edges, w)).toEqual([4, 0, 4, 2, 4, 3, 4, 4, 5, 3, 7, 3]);
  });
  it('does not join runs across rows', () => {
    const w = 4;
    // horizontal lines at the end of row 0 and the start of row 1 have adjacent keys only if the row is ignored
    const edges = [edgeId(3, 1), edgeId(w + 0, 1)];
    expect(mergeSegments(edges, w)).toEqual([3, 1, 4, 1, 0, 2, 1, 2]);
  });
  it('turns a staircase into unit steps', () => {
    const w = 8;
    const h = 8;
    const own = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) own[y * w + x] = x <= y ? 1 : 2;
    const segs = mergeSegments(scan((i) => own[i], w, h, 1, 2), w);
    let len = 0;
    for (let k = 0; k < segs.length; k += 4) len += Math.abs(segs[k + 2] - segs[k]) + Math.abs(segs[k + 3] - segs[k + 1]);
    expect(len).toBe(7 + 7);
  });
});

describe('chainSegments', () => {
  const length = (lines: number[][]): number => {
    let len = 0;
    for (const l of lines) for (let k = 2; k < l.length; k += 2) len += Math.abs(l[k] - l[k - 2]) + Math.abs(l[k + 1] - l[k - 1]);
    return len;
  };
  it('joins an L into one polyline and a closed square into one loop', () => {
    expect(chainSegments([4, 0, 4, 3, 4, 3, 7, 3])).toEqual([[4, 0, 4, 3, 7, 3]]);
    const sq = chainSegments([0, 0, 2, 0, 0, 2, 2, 2, 0, 0, 0, 2, 2, 0, 2, 2]);
    expect(sq.length).toBe(1);
    expect(sq[0].length).toBe(10);
    expect(length(sq)).toBe(8);
  });
  it('keeps every unit of a staircase border', () => {
    const w = 12;
    const h = 12;
    const own = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) own[y * w + x] = x <= y || (x > 8 && y < 3) ? 1 : 2;
    const segs = mergeSegments(scan((i) => own[i], w, h, 1, 2), w);
    let total = 0;
    for (let k = 0; k < segs.length; k += 4) total += Math.abs(segs[k + 2] - segs[k]) + Math.abs(segs[k + 3] - segs[k + 1]);
    const lines = chainSegments(segs);
    expect(length(lines)).toBe(total);
    expect(lines.length).toBeLessThan(segs.length / 4);
  });
});

describe('far zoom lines', () => {
  it('keeps every point from about a pixel per tile up', () => {
    expect(farStep(1.2)).toBe(0);
    expect(farStep(4)).toBe(0);
    expect(farStep(1)).toBe(1);
    expect(farStep(0.5)).toBe(2);
    expect(farStep(0.2)).toBe(4);
  });
  it('drops stair steps within the step but keeps both ends and long runs', () => {
    const stairs = [0, 0, 1, 0, 1, 1, 2, 1, 2, 2, 3, 2, 3, 3];
    const s1 = simplifyLine(stairs, 1);
    expect(s1.slice(0, 2)).toEqual([0, 0]);
    expect(s1.slice(-2)).toEqual([3, 3]);
    expect(s1.length).toBeLessThan(stairs.length);
    for (let k = 2; k < s1.length - 2; k += 2) expect(Math.hypot(s1[k] - s1[k - 2], s1[k + 1] - s1[k - 1])).toBeGreaterThan(1);
    expect(simplifyLine([0, 0, 10, 0, 10, 8], 1)).toEqual([0, 0, 10, 0, 10, 8]);
    expect(simplifyLine([0, 0, 5, 0], 4)).toEqual([0, 0, 5, 0]);
  });
  it('cuts lines into pieces that share their ends and cover every point', () => {
    const l: number[] = [];
    for (let k = 0; k < 100; k++) l.push(k, k % 2);
    const ch = chunkLines([l, [0, 0, 3, 0]], 10);
    expect(ch.length).toBe(12); // 100 points in pieces of 10 sharing ends: 11, plus the short line
    expect(ch[0].pts.slice(-2)).toEqual(ch[1].pts.slice(0, 2));
    expect(ch[10].pts.slice(-2)).toEqual([99, 1]);
    expect(ch[0].box).toEqual([0, 0, 9, 1]);
    expect(ch[11].pts).toEqual([0, 0, 3, 0]);
  });
});

describe('frontSpots', () => {
  it('points from the lower id into the other side, on the border', () => {
    const w = 40;
    const h = 30;
    const own = new Uint16Array(w * h);
    for (let i = 0; i < own.length; i++) own[i] = i % w < 20 ? 1 : 2;
    const edges = scan((i) => own[i], w, h, 1, 2);
    const spots = frontSpots(edges, (i) => own[i], 1, w, 10);
    expect(spots.length).toBe(3);
    for (const s of spots) {
      expect(s.dx).toBeCloseTo(1);
      expect(s.dy).toBeCloseTo(0);
      expect(s.x).toBe(20);
    }
    // seen from player 2 the push goes the other way
    expect(frontSpots(edges, (i) => own[i], 2, w, 10)[0].dx).toBeCloseTo(-1);
  });
  it('drops cells whose edges point every way', () => {
    const w = 9;
    const own = new Uint16Array(w * w).fill(1);
    own[4 * w + 4] = 2; // a single enemy tile: four edges, opposite directions cancel
    expect(frontSpots(scan((i) => own[i], w, w, 1, 2), (i) => own[i], 1, w, 20)).toEqual([]);
  });
});

describe('measuredSpeed', () => {
  it('reads tiles per game second from (tick, taken) samples', () => {
    expect(measuredSpeed([])).toBe(0);
    expect(measuredSpeed([10, 0, 20, 50])).toBe(50);
    expect(measuredSpeed([0, 0, 10, 4, 20, 8])).toBeCloseTo(4);
  });
});

describe('seedEdges', () => {
  it('finds the shared border from one side', () => {
    const w = 12;
    const h = 7;
    const own = new Uint16Array(w * h);
    for (let i = 0; i < own.length; i++) own[i] = i % w < 5 ? 1 : i % w < 9 ? 2 : 3;
    const list: number[] = [];
    for (let i = 0; i < own.length; i++) if (own[i] === 2) list.push(i);
    const out = new Set<number>();
    seedEdges((i) => own[i], list, list.length, 2, 1, w, w * h, out);
    expect(out).toEqual(scan((i) => own[i], w, h, 1, 2));
  });
});

describe('FrontLayer', () => {
  it('keeps a warring pair\'s border edges in step with the tile feed', () => {
    const w = 48;
    const h = 32;
    const s = fakeState(w, h);
    for (let i = 0; i < w * h; i++) s.map.owner[i] = i % w < 20 ? 1 : i % w < 36 ? 2 : 3;
    s.attacks.push(attack(1, 1, 2));
    const feed = new TileFeed();
    feed.reset(s);
    const layer = new FrontLayer();
    layer.reset(w, feed);
    feed.listeners.push(layer.onChange);
    const mirror = (i: number): number => feed.mirror[i] & OWNER_MASK;
    s.tick = 1;
    layer.begin(s, 0);
    expect(layer.edgesOf(1, 2)).toEqual(scan(mirror, w, h, 1, 2));
    expect(layer.edgesOf(2, 3)).toBeUndefined(); // no fight there
    // random captures all over the map (re-seeding from the border lists runs every 2.5 s in between), applied through the feed a few frames at a time
    const { rng } = makeRng(7);
    for (let round = 0; round < 40; round++) {
      for (let k = 0; k < 60; k++) {
        const i = Math.floor(rng() * w * h);
        const old = s.map.owner[i];
        const nw = 1 + Math.floor(rng() * 3);
        if (nw === old) continue;
        s.map.owner[i] = nw;
        onOwnerChange(s, i, old, nw); // the sim's border lists (re-seeding reads them)
        recordTileChange(s, i);
      }
      s.tick++;
      layer.begin(s, round * 100);
      feed.update(round * 100, 2);
      feed.update(round * 100 + 16, 2);
      expect(layer.edgesOf(1, 2)).toEqual(scan(mirror, w, h, 1, 2));
    }
  });

  it('forgets a front WAR_MEMORY_TICKS after the last attack across it', () => {
    const w = 20;
    const h = 10;
    const s = fakeState(w, h);
    for (let i = 0; i < w * h; i++) s.map.owner[i] = i % w < 10 ? 1 : 2;
    s.attacks.push(attack(1, 2, 1));
    const feed = new TileFeed();
    feed.reset(s);
    const layer = new FrontLayer();
    layer.reset(w, feed);
    s.tick = 1;
    layer.begin(s, 0);
    expect(layer.edgesOf(1, 2)?.size).toBe(h);
    s.attacks = [];
    s.tick = 1 + WAR_MEMORY_TICKS;
    layer.begin(s, 100);
    expect(layer.edgesOf(1, 2)).toBeDefined();
    s.tick = 2 + WAR_MEMORY_TICKS;
    layer.begin(s, 200);
    expect(layer.edgesOf(1, 2)).toBeUndefined();
    expect(pairKey(2, 1)).toBe(pairKey(1, 2));
  });

  it('draws a front that only touches after the attack started (amphibious landing, far off screen)', () => {
    const w = 60;
    const h = 40;
    const s = fakeState(w, h);
    for (let i = 0; i < w * h; i++) s.map.owner[i] = i % w < 10 ? 1 : i % w >= 50 ? 2 : 0;
    s.attacks.push(attack(1, 1, 2));
    const feed = new TileFeed();
    feed.reset(s);
    const layer = new FrontLayer();
    layer.reset(w, feed);
    feed.listeners.push(layer.onChange);
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
    const cam = new Camera(w, h);
    cam.resize(1200, 800);
    const ui = { hoverTile: -1, hoverPx: null, mode: { kind: 'none' }, contextMenu: null } as unknown as UiState;
    const frame = (k: number): void => {
      layer.begin(s, k * 16);
      feed.update(k * 16, 1);
      layer.drawLines(ctx, s, cam, ui, 1);
    };
    s.tick = 1;
    frame(1);
    expect(layer.segments).toBe(0); // no shared border yet
    // player 1 lands next to player 2
    for (let y = 0; y < h; y++) {
      const i = y * w + 49;
      s.map.owner[i] = 1;
      recordTileChange(s, i);
    }
    for (let k = 2; k < 12; k++) {
      s.tick = k;
      frame(k);
    }
    expect(layer.segments).toBe(1);
  });

  it('ignores fights with tribes', () => {
    const w = 20;
    const h = 10;
    const s = fakeState(w, h);
    (s.players[2] as { personality: string }).personality = 'tribe';
    for (let i = 0; i < w * h; i++) s.map.owner[i] = i % w < 10 ? 1 : 2;
    s.attacks.push(attack(1, 1, 2));
    const feed = new TileFeed();
    feed.reset(s);
    const layer = new FrontLayer();
    layer.reset(w, feed);
    s.tick = 1;
    layer.begin(s, 0);
    expect(layer.edgesOf(1, 2)).toBeUndefined();
  });
});
