// Natural ground for real ground (render/ground.ts mixA, mixB, mixC and the far colours; shaders.ts NATURAL): the data
// the shader draws rounded terrain edges, soft edges between terrains and variety inside them from. Only looks: the
// terrain itself is never changed. Client only.
import { describe, expect, it } from 'vitest';
import type { MapData } from '../src/sim/types';
import { buildGround, GROUND } from '../src/client/render/ground';
import { groundFragmentShader } from '../src/client/render/shaders';
import { buildTerrain } from '../src/client/render/terrain';

/** w x h: sea on the left 6 columns, then plains with a forest block, a mountain block and a desert block. */
function testMap(w = 80, h = 120): MapData {
  const n = w * h;
  const terrain = new Uint8Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      terrain[i] = x < 6 ? 0 : 2;
      if (x >= 20 && x < 40 && y >= 10 && y < 30) terrain[i] = 3; // forest
      if (x >= 50 && x < 70 && y >= 10 && y < 40) terrain[i] = 5; // mountains
      if (x >= 20 && x < 40 && y >= 60 && y < 80) terrain[i] = 6; // desert
    }
  return { width: w, height: h, terrain, resource: new Uint8Array(n), owner: new Uint16Array(n), building: new Int32Array(n), coastal: new Uint8Array(n), fallout: new Float32Array(n), landTileCount: n } as unknown as MapData;
}
const ground = (map: MapData) => buildGround(map, buildTerrain(map).depth);
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

describe('natural ground data', () => {
  it('gives every land tile exactly its own terrain share, full, and the sea none', () => {
    const map = testMap();
    const g = ground(map);
    // channels: mixA forest, desert, mountains, hills; mixB swamp, tundra, plains
    const chan: Record<number, [Uint8Array, number]> = { 3: [g.mixA, 0], 6: [g.mixA, 1], 5: [g.mixA, 2], 4: [g.mixA, 3], 7: [g.mixB, 0], 8: [g.mixB, 1], 2: [g.mixB, 2] };
    for (let i = 0; i < map.terrain.length; i++) {
      const t = map.terrain[i];
      let full = 0;
      for (const [tex, c] of Object.values(chan)) if (tex[i * 4 + c] === 255) full++;
      if (t <= 1) expect(full).toBe(0);
      else {
        expect(full, `tile ${i}`).toBe(1);
        const [tex, c] = chan[t];
        expect(tex[i * 4 + c]).toBe(255);
      }
    }
  });

  it('knows how near each terrain is: full deep inside, fading over a few tiles, none far away (half size grid)', () => {
    const map = testMap();
    const g = ground(map);
    expect(g.mixCW).toBe(40);
    expect(g.mixCH).toBe(60);
    const forestAt = (x: number, y: number) => g.mixC[((y >> 1) * g.mixCW + (x >> 1)) * 4];
    expect(forestAt(30, 20)).toBeGreaterThan(240); // the forest's middle
    expect(forestAt(42, 20)).toBeGreaterThan(0); // just outside: lone trees can stand here
    expect(forestAt(42, 20)).toBeLessThan(forestAt(38, 20));
    expect(forestAt(30, 50)).toBe(0); // far away
  });

  it('has a slow moisture field, wetter in the north on average', () => {
    const map = testMap(120, 400);
    const g = ground(map);
    let north = 0;
    let south = 0;
    let min = 255;
    let max = 0;
    for (let y = 0; y < 400; y++)
      for (let x = 6; x < 120; x++) {
        const m = g.mixB[(y * 120 + x) * 4 + 3];
        if (y < 100) north += m;
        if (y >= 300) south += m;
        min = Math.min(min, m);
        max = Math.max(max, m);
      }
    expect(north).toBeGreaterThan(south);
    expect(max - min).toBeGreaterThan(60);
  });

  it('shows mountains far out as rock with some snow, not a pale lump', () => {
    const map = testMap();
    const g = ground(map);
    let n = 0;
    let sum = 0;
    let snowy = 0;
    const snowY = luma(...(GROUND.snow[2] as [number, number, number]));
    for (let y = 14; y < 36; y++)
      for (let x = 54; x < 66; x++) {
        const o = (y * map.width + x) * 4;
        const y0 = luma(g.far[o], g.far[o + 1], g.far[o + 2]);
        sum += y0;
        n++;
        if (y0 > snowY * 0.85) snowy++;
      }
    expect(sum / n).toBeLessThan(snowY * 0.7);
    expect(snowy / n).toBeLessThan(0.25);
  });

  it('draws natural ground only in real ground (the other pixel styles keep their ground pass)', () => {
    expect(groundFragmentShader('ground')).toMatch(/#define MAP_STYLE 3[\s\S]*#define GROUND_PASS 1/);
    // NATURAL is defined only under MAP_STYLE 3 in the source
    const src = groundFragmentShader('pixel');
    expect(src).toContain('#if MAP_STYLE == 3\n// Real ground draws natural ground');
    expect(src).toContain('#define MAP_STYLE 1');
  });
});
