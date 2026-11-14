// The map style switch (render/mapStyle.ts) and what it feeds the map layer: one shader per style (today's unchanged),
// the pixel styles' ground data and fill strengths. Client only; nothing here touches the sim.
import { describe, expect, it } from 'vitest';
import type { MapData } from '../src/sim/types';
import { buildGround } from '../src/client/render/ground';
import { DEFAULT_MAP_STYLE, MAP_STYLES, mapStyle, parseMapStyle, setMapStyle } from '../src/client/render/mapStyle';
import { displayColor, fillAlpha, NATION_ALPHA, TRIBE_ALPHA } from '../src/client/render/palette';
import { MAP_FS, mapFragmentShader } from '../src/client/render/shaders';
import { buildTerrain } from '../src/client/render/terrain';

function fakeMap(w: number, h: number): MapData {
  const n = w * h;
  const terrain = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) terrain[y * w + x] = x < 6 ? 0 : x < 8 ? 1 : 2 + ((x >> 3) + (y >> 3)) % 7;
  return { width: w, height: h, terrain, resource: new Uint8Array(n), owner: new Uint16Array(n), building: new Int32Array(n), coastal: new Uint8Array(n), fallout: new Float32Array(n), landTileCount: n } as unknown as MapData;
}

describe('map style switch', () => {
  it('reads a, b, c and today from the page address words', () => {
    expect(parseMapStyle('a')).toBe('pixel');
    expect(parseMapStyle('B')).toBe('muted');
    expect(parseMapStyle(' c ')).toBe('ground');
    expect(parseMapStyle('today')).toBe('today');
    expect(parseMapStyle('nope')).toBeNull();
    expect(parseMapStyle(null)).toBeNull();
  });

  it('starts on today and switches at run time', () => {
    expect(DEFAULT_MAP_STYLE).toBe('today');
    expect(mapStyle()).toBe('today');
    setMapStyle('ground');
    expect(mapStyle()).toBe('ground');
    setMapStyle('today');
    expect(mapStyle()).toBe('today');
  });
});

describe('map shaders', () => {
  it("keeps today's shader as it was and builds one per style", () => {
    expect(mapFragmentShader('today')).toBe(MAP_FS);
    expect(MAP_FS).toContain('#define MAP_STYLE 0');
    const ids = MAP_STYLES.map((s) => /#define MAP_STYLE (\d)/.exec(mapFragmentShader(s))?.[1]);
    expect(ids).toEqual(['0', '1', '2', '3']);
  });
});

describe('pixel ground', () => {
  it('is deterministic, shades slopes from the top left and gives the far view a colour per tile', () => {
    const map = fakeMap(48, 32);
    const terr = buildTerrain(map);
    const a = buildGround(map, terr.depth);
    const b = buildGround(map, terr.depth);
    expect(a.data).toEqual(b.data);
    expect(a.far).toEqual(b.far);
    expect(a.data.length).toBe(48 * 32 * 4);
    // plains rising into mountains to the right face the light (top left): brighter than flat; the far side darker
    const ridge = fakeMap(48, 32);
    ridge.terrain.fill(2);
    for (let y = 0; y < 32; y++) for (let x = 20; x < 28; x++) ridge.terrain[y * 48 + x] = 5;
    const r = buildGround(ridge, buildTerrain(ridge).depth);
    expect(r.data[(16 * 48 + 18) * 4]).toBeGreaterThan(140);
    expect(r.data[(16 * 48 + 29) * 4]).toBeLessThan(116);
    // every far colour is opaque
    for (let i = 3; i < a.far.length; i += 4) expect(a.far[i]).toBe(255);
  });
});

describe('fill strength per style', () => {
  it("leaves today's fill as it was and keeps tribes lighter than nations", () => {
    expect(fillAlpha('today', false)).toBe(NATION_ALPHA);
    expect(fillAlpha('today', true)).toBe(TRIBE_ALPHA);
    for (const s of MAP_STYLES) expect(fillAlpha(s, true)).toBeLessThanOrEqual(fillAlpha(s, false));
    expect(displayColor([64, 160, 255], { role: 'own' })).toEqual(displayColor([64, 160, 255], { role: 'own', style: 'today' }));
  });
});
