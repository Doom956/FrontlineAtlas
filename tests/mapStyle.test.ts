// The map style switch (render/mapStyle.ts) and what it feeds the map layer: one shader per style (today's unchanged),
// the pixel styles' ground data and fill strengths. Client only; nothing here touches the sim.
import { describe, expect, it } from 'vitest';
import type { MapData } from '../src/sim/types';
import { buildGround, GROUND, groundFor } from '../src/client/render/ground';
import { DEFAULT_MAP_STYLE, MAP_STYLE_MENU, MAP_STYLE_SHORT, MAP_STYLES, mapStyle, parseMapStyle, setMapStyle } from '../src/client/render/mapStyle';
import { displayColor, fillAlpha, GROUND_TINT, groundTint, NATION_ALPHA, toOklch, TRIBE_ALPHA } from '../src/client/render/palette';
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

  it('starts on real ground and switches at run time', () => {
    expect(DEFAULT_MAP_STYLE).toBe('ground');
    expect(mapStyle()).toBe('ground');
    setMapStyle('today');
    expect(mapStyle()).toBe('today');
    setMapStyle('ground');
    expect(mapStyle()).toBe('ground');
  });

  it('lists real ground first in the menu and calls the earlier look Classic', () => {
    expect(MAP_STYLE_MENU[0]).toBe('ground');
    expect([...MAP_STYLE_MENU].sort()).toEqual([...MAP_STYLES].sort());
    expect(MAP_STYLE_SHORT.today).toBe('Classic');
    expect(MAP_STYLE_SHORT.ground).toBe('Real ground');
    expect(parseMapStyle('classic')).toBe('today');
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

describe('real ground tint', () => {
  // hue difference in degrees (OKLCH) and chroma of a colour
  const hueOff = (a: readonly number[], b: readonly number[]): number => {
    let d = Math.abs(toOklch(a)[2] - toOklch(b)[2]) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return (d * 180) / Math.PI;
  };
  const chroma = (c: readonly number[]): number => toOklch(c)[1];
  const NATIONS = [[220, 60, 60], [60, 110, 230], [240, 190, 40], [150, 70, 200], [40, 190, 170], [240, 120, 40], [230, 90, 170], [120, 200, 60]];
  const GROUNDS = { grass: GROUND.grass[2], forest: GROUND.forest[2], sand: GROUND.sand[2], snow: GROUND.snow[2], tundra: GROUND.tundra[2], rock: GROUND.rock[2] };

  it('keeps each nation in its own hue on every ground far out and in the border band (no brown red on grass)', () => {
    for (const c of NATIONS) {
      const d = displayColor(c, { style: 'ground' });
      for (const [g, gc] of Object.entries(GROUNDS)) {
        for (const [what, k, maxOff] of [['far', GROUND_TINT.far, 12], ['band', GROUND_TINT.band, 6]] as const) {
          const t = groundTint(gc, d, k);
          expect(hueOff(t, d), `${c} on ${g}, ${what}: hue`).toBeLessThan(maxOff);
          expect(chroma(t), `${c} on ${g}, ${what}: colour kept`).toBeGreaterThan(chroma(d) * (what === 'band' ? 0.75 : 0.55));
        }
      }
    }
  });

  it('holds the hue better than a plain blend, and close in stays a light tint over the ground', () => {
    const red = displayColor([220, 60, 60], { style: 'ground' });
    const grass = GROUND.grass[2];
    const blend = [0, 1, 2].map((i) => grass[i] + (red[i] - grass[i]) * 0.54);
    const far = groundTint(grass, red, GROUND_TINT.far);
    expect(chroma(far)).toBeGreaterThan(chroma(blend) * 1.3);
    // close in: nearer the ground's own colour than far out, still leaning to the nation's hue
    const near = groundTint(grass, red, GROUND_TINT.near);
    const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(near, grass)).toBeLessThan(dist(far, grass));
    expect(hueOff(near, red)).toBeLessThan(hueOff(grass, red));
  });

  it('keeps the ground light and dark under a nation (forest darker than sand)', () => {
    const blue = displayColor([60, 110, 230], { style: 'ground' });
    const y = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    for (const k of [GROUND_TINT.near, GROUND_TINT.far]) expect(y(groundTint(GROUND.forest[2], blue, k))).toBeLessThan(y(groundTint(GROUND.sand[2], blue, k)));
  });

  it('puts the same numbers in the shader', () => {
    const fs = mapFragmentShader('ground');
    expect(fs).toContain(`const vec4 TINT_FAR = vec4(${GROUND_TINT.far.map((v) => v.toFixed(3)).join(', ')});`);
    expect(fs).toContain(`const vec4 TINT_BAND = vec4(${GROUND_TINT.band.map((v) => v.toFixed(3)).join(', ')});`);
  });

  it('builds the ground once per map for the map layer, the minimap and the 2D fallback', () => {
    const map = fakeMap(32, 24);
    const depth = buildTerrain(map).depth;
    expect(groundFor(map, depth)).toBe(groundFor(map, depth));
  });
});
